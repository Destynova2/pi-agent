"""Exercise real Pi terminal handoff with a fake Grob and no provider calls."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

node, cli, command, root = sys.argv[1:]
root = Path(root)
for directory in ["home", "agent", "project", "bin"]:
    (root / directory).mkdir()
config = root / "config.toml"
config.write_text("# fixture\n")
fake = root / "bin/grob"
fake.write_text(
    f"#!{sys.executable}\n"
    "import os,sys,json\n"
    "assert all(os.isatty(fd) for fd in [0,1,2])\n"
    "print('FIXTURE_LOGIN_READY', flush=True)\n"
    "input()\n"
    "with open(os.environ['FIXTURE_PROOF'], 'w') as f:\n"
    " json.dump({'args':sys.argv[1:], 'cwd':os.getcwd()}, f)\n"
)
fake.chmod(0o700)
(root / "agent/settings.json").write_text(json.dumps({"packages": [], "quietStartup": True}))
(root / "fixture.ts").write_text(
    f"import {{ registerGrobCommand, grobTerminal }} from {json.dumps(command)};\n"
    "export default function(pi) {\n"
    " let probes=0;\n"
    " registerGrobCommand(pi, 'http://127.0.0.1:1', async()=>true, {\n"
    "  providers: async()=>['anthropic','chatgpt-codex'], terminal: grobTerminal });\n"
    " pi.on('session_start', (_,ctx)=>ctx.ui.notify('FIXTURE_SESSION_READY','info'));\n"
    " pi.registerCommand('fixtureprobe', {handler:async(_,ctx)=>ctx.ui.notify('FIXTURE_PROMPT_READY_'+(++probes),'info')});\n"
    " pi.registerCommand('fixtureexit', {handler:async(_,ctx)=>ctx.shutdown()});\n"
    "}\n"
)
env = dict(
    os.environ, HOME=str(root / "home"),
    PATH=str(root / "bin") + os.pathsep + os.environ["PATH"],
    PI_CODING_AGENT_DIR=str(root / "agent"), PI_OFFLINE="1",
    GROB_CONFIG=str(config), FIXTURE_PROOF=str(root / "proof.json"),
    TERM="xterm-256color",
)
for key in ["GROB_HOME", "PI_SUBAGENT_CHILD", "NODE_OPTIONS"]:
    env.pop(key, None)
args = [
    node, cli, "--offline", "--no-session", "--no-approve", "--no-tools",
    "--no-extensions", "--no-skills", "--no-mcp", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--tui-mode", "regular",
    "-e", str(root / "fixture.ts"),
]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root / "project")
    os.execve(node, args, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
transcript = bytearray()


def wait_for(marker, start=0, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if marker is not None and marker in transcript[start:]:
            return
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            transcript.extend(data)
    if marker is None:
        return
    text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)", "", transcript.decode(errors="replace"))
    tail = "\n".join(line.strip() for line in text.splitlines() if line.strip() and not set(line.strip()) <= {"─"})
    raise RuntimeError(f"Did not observe {marker!r}; terminal tail:\n{tail[-2500:]}")


def send(text):
    start = len(transcript)
    os.write(fd, text)
    return start


try:
    wait_for(b"FIXTURE_SESSION_READY")
    wait_for(b"FIXTURE_PROMPT_READY_1", send(b"/fixtureprobe\r"))
    wait_for(b"Connecter un fournisseur", send(b"/grob\r"))
    send(b"\x1b")
    # Escape is an ambiguous terminal sequence; give Pi's input decoder its timeout.
    # Keep draining the pty meanwhile: a full macOS pty buffer blocks Pi's redraw, so the
    # timer never fires and ESC merges with the next command into one Alt sequence.
    wait_for(None, timeout=0.2)
    wait_for(b"FIXTURE_PROMPT_READY_2", send(b"/fixtureprobe\r"))
    wait_for(b"FIXTURE_LOGIN_READY", send(b"/grob connect anthropic\r"))
    wait_for("Assistant Grob terminé".encode(), send(b"fixture-code\r"))
    proof = json.loads((root / "proof.json").read_text())
    assert proof == {
        "args": ["--config", str(config), "connect", "anthropic"],
        "cwd": str(root / "home"),
    }, proof
    wait_for(b"FIXTURE_PROMPT_READY_3", send(b"/fixtureprobe\r"))
    wait_for(b"FIXTURE_LOGIN_READY", send(b"/grob reconnect chatgpt-codex\r"))
    wait_for("Assistant Grob terminé".encode(), send(b"fixture-code\r"))
    assert json.loads((root / "proof.json").read_text())["args"][-1] == "--force-reauth"
    wait_for(b"FIXTURE_LOGIN_READY", send(b"/grob connect anthropic\r"))
    wait_for(b"Assistant Grob interrompu", send(b"\x03"))
    wait_for(b"FIXTURE_PROMPT_READY_4", send(b"/fixtureprobe\r"))
    send(b"/fixtureexit\r")
    print("PASS: Pi menu, connect, reconnect, Ctrl+C and return to prompt")
finally:
    (root / "terminal.log").write_bytes(transcript)
    try:
        os.kill(pid, signal.SIGTERM)
        # Pi ignores SIGTERM while a modal is open; do not let a failed step hang the test.
        for _ in range(50):
            if os.waitpid(pid, os.WNOHANG) != (0, 0):
                break
            time.sleep(0.1)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except ProcessLookupError:
        pass
    os.close(fd)
