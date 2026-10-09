import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { privateIpcSeccomp } from "../lib/private-ipc-seccomp.mjs";
import { snapshotCommand, isolatedArgs, isolatedRuntime } from "../lib/isolated-command.ts";
import { runProcess } from "../lib/process.ts";

test("native private IPC works while host files, environment and external network remain inaccessible", { skip: process.platform !== "linux", timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-private-native-"))), agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  writeFileSync(join(root, "host-only"), "must remain hidden");
  writeFileSync(join(cwd, "probe.py"), `import os, socket, pathlib, json
assert 'PI_PRIVATE_TEST_SECRET' not in os.environ
assert not pathlib.Path(${JSON.stringify(join(root, "host-only"))}).exists()
assert not pathlib.Path('/run/user').exists()
for name in json.loads(pathlib.Path('runtime-masks.json').read_text()):
 masked = pathlib.Path(name)
 assert not list(masked.iterdir())
 try:
  (masked / 'forbidden').write_text('must fail')
  raise AssertionError('hidden runtime directory unexpectedly writable')
 except OSError: pass
path = os.environ['TMPDIR'] + '/plugin1234567890'
assert len(path.encode()) < 108
server = socket.socket(socket.AF_UNIX); server.bind(path); server.listen(1)
client = socket.socket(socket.AF_UNIX); client.connect(path)
peer, _ = server.accept(); client.sendall(b'provider-schema'); assert peer.recv(64) == b'provider-schema'
peer.close(); client.close(); server.close()
abstract = socket.socket(socket.AF_UNIX); abstract.bind('\\0pi-private-test'); abstract.close()
for family in [socket.AF_INET, socket.AF_INET6, 40]:
 try:
  remote = socket.socket(family)
  remote.close()
  raise AssertionError('non-Unix socket unexpectedly available')
 except PermissionError: pass
pathlib.Path('generated').write_text('disposable')
try:
 pathlib.Path('/input/host-write').write_text('forbidden')
 raise AssertionError('snapshot unexpectedly writable')
except OSError: pass
print('private IPC and confinement verified')
`);
  let snapshot;
  try {
    const runtime = isolatedRuntime();
    writeFileSync(join(cwd, "runtime-masks.json"), JSON.stringify(runtime.masked));
    snapshot = snapshotCommand(cwd, agent, ["probe.py", "runtime-masks.json"]);
    const result = await runProcess(runtime.backend, isolatedArgs(snapshot, "python3 probe.py", runtime), { cwd: snapshot.directory, input: Readable.from([privateIpcSeccomp()]), timeoutMs: 20000, env: { PI_PRIVATE_TEST_SECRET: "not-for-child" } });
    assert.match(result, /private IPC and confinement verified/);
    assert.throws(() => readFileSync(join(cwd, "generated")), /ENOENT/);
    assert.throws(() => readFileSync(join(snapshot.workspace, "generated")), /ENOENT/);
  } finally { snapshot?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
