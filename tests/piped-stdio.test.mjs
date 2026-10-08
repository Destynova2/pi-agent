import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runProcess } from "../lib/process.ts";
import { LINUX_STDIO_RELAY } from "../scripts/codex-shell.mjs";
import { spawn } from "../extensions/confined-lsp/piped-spawn.mjs";

const linux = { skip: process.platform !== "linux", timeout: 5000 };
const args = script => ["--noprofile", "--norc", "-c", script, "pi-relay-test"];

test("stdio supervisor reaps a relay even when its exit follows the last closed output", linux, async () => {
  // Make the real scheduling race deterministic: no inherited output keeps
  // child.close pending, but the stderr relay still needs to be waited for.
  const script = LINUX_STDIO_RELAY.replace("/bin/cat >&2",
    "/bin/cat >&2; exec 0<&- 1>&- 2>&- 3<&-; /bin/sleep 0.2");
  let stderr = "";
  const result = await runProcess("/bin/bash", [...args(script), "/bin/bash", "-c", "cat; printf diagnostic >&2"], {
    cwd: tmpdir(), input: "payload", graceMs: 10, timeoutMs: 3000,
    onStderr: chunk => { stderr += chunk; },
  });
  assert.equal(result, "payload");
  assert.equal(stderr, "diagnostic");
});

test("stdio supervisor preserves failure status and stops its relay with stdin still open", linux, async () => {
  const input = new PassThrough();
  input.write("request\n");
  try {
    await assert.rejects(runProcess("/bin/bash", [...args(LINUX_STDIO_RELAY), "/bin/bash", "-c",
      "read -r line; printf '%s' \"$line\" >&2; exit 23"], {
      cwd: tmpdir(), input, graceMs: 10, timeoutMs: 3000,
    }), /code 23, signal none\nrequest/);
  } finally { input.destroy(); }
});

test("LSP spawn supplies real pipes and leaves no relay after server exit", linux, async () => {
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    if (![0, 1, 2].every(fd => fs.fstatSync(fd).isFIFO())) process.exit(3);
    process.stdout.write("out"); process.stderr.write("err");
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    assert.deepEqual(await once(child, "close"), [0, null]);
    assert.equal(stdout, "out"); assert.equal(stderr, "err");
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  } finally {
    child.stdin.destroy();
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
});
