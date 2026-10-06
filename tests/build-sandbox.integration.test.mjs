import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxArgs, buildSourceIdentity, kvmStatus } from "../lib/build-sandbox.ts";
import { runProcess } from "../lib/process.ts";

test("native KVM build creates a VM, reaches local HTTP and confines writes", { skip: process.platform !== "linux", timeout: 30000 }, async () => {
  const kvm = kvmStatus();
  assert.equal(kvm.available, true, `Native prerequisite: readable/writable /dev/kvm on the host (${kvm.reason ?? "unknown"}). No sandbox assertions executed.`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-kvm-native-"))), cwd = join(root, "project"), scratch = join(root, "scratch");
  const server = createServer((_request, response) => response.end("local fixture"));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    for (const name of ["ansible", "packer", "config", ".cache", "output", ".git", ".pi", ".agents", ".codex"]) mkdirSync(join(cwd, name), { recursive: true });
    mkdirSync(scratch);
    writeFileSync(join(cwd, "ansible/build.yml"), "fixture\n"); writeFileSync(join(cwd, "ansible.cfg"), "[defaults]\n");
    const outside = join(root, "outside"); writeFileSync(outside, "untouched");
    const program = join(root, "ansible-playbook");
    writeFileSync(program, `#!${process.execPath}
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
assert.deepEqual(process.argv.slice(2), ['-i', 'localhost,', 'ansible/build.yml']);
assert.equal(fs.statSync('/dev/kvm').isCharacterDevice(), true);
assert.equal(process.env.PI_BUILD_CONFINED, '1');
assert.equal(process.env.FIXTURE_PRIVATE_ENV, undefined);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1/);
for (const file of ['.cache/written', 'output/written', process.env.TMPDIR + '/written']) fs.writeFileSync(file, 'ok');
for (const file of ['ansible/build.yml', 'ansible.cfg', 'config/blocked', '.git/blocked', '.pi/blocked', '.agents/blocked', '.codex/blocked', 'root-write', ${JSON.stringify(outside)}]) {
  assert.throws(() => fs.writeFileSync(file, 'denied'), /EROFS|EACCES|EPERM/, file);
}
await new Promise((resolve, reject) => {
  const req = http.get('http://127.0.0.1:${server.address().port}', res => {
    let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { try { assert.equal(text, 'local fixture'); resolve(); } catch (error) { reject(error); } });
  }); req.on('error', reject);
});
console.log('native KVM, network and filesystem checks passed');
`, { mode: 0o755 });
    const plan = { cwd, path: "/usr/bin:/bin", worker: fileURLToPath(new URL("../scripts/build-worker.mjs", import.meta.url)), executable: { command: program }, sourceSha256: buildSourceIdentity(cwd) };
    const output = await runProcess("/usr/bin/bwrap", buildSandboxArgs(plan, scratch), { cwd, timeoutMs: 20000, env: { FIXTURE_PRIVATE_ENV: "must be cleared" } });
    assert.match(output, /native KVM, network and filesystem checks passed/);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    for (const file of [".cache/written", "output/written"]) assert.equal(readFileSync(join(cwd, file), "utf8"), "ok");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
