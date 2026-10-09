import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { registerCommandAccess } from "../extensions/tool-policy/command-access.ts";
import { runProcess } from "../lib/process.ts";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(network, run) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-command-jail-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), home = join(root, "home");
  mkdirSync(join(agent, "scripts"), { recursive: true }); mkdirSync(cwd); mkdirSync(home);
  for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
  const launcher = join(agent, "scripts/codex-shell.mjs"); chmodSync(launcher, 0o755);
  writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: network ? ["github.com"] : [] }));
  const previous = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "PI_CODEX_NETWORK_GRANTS"].map(key => [key, process.env[key]]));
  process.env.PI_CODEX_SANDBOX_BIN = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = agent; delete process.env.PI_CODEX_NETWORK_GRANTS;
  const handlers = new Map(); let tool; let prompts = 0;
  const ctx = { cwd, hasUI: true, ui: { confirm: async (_title, text) => { prompts++; assert.match(text, /ENTIRE failed command/); return true; } } };
  registerCommandAccess({ on: (event, handler) => handlers.set(event, handler), registerCommand() {}, registerTool: value => { tool = value; }, getActiveTools: () => ["request_command_access"] }, agent, () => {});
  await handlers.get("session_start")({}, ctx);
  const options = { cwd, timeoutMs: 30_000, maxBytes: 1024 * 1024 };
  const capture = async command => {
    const event = { toolName: "bash", toolCallId: "failed", input: { command } };
    handlers.get("tool_call")(event, ctx);
    let error;
    try { await runProcess(launcher, ["-c", command], options); } catch (failure) { error = failure; }
    assert.ok(error, "ordinary sandbox execution must fail before requesting a grant");
    assert.match(error.message, /EPERM|EACCES|EROFS|not permitted|denied|read-only/i);
    handlers.get("tool_result")({ ...event, content: [{ type: "text", text: error.message }], isError: true }, ctx);
  };
  try {
    await run({ root, agent, cwd, launcher, options, capture, handlers, ctx, get prompts() { return prompts; }, request: (paths, signal) => tool.execute("approval", { failed_call_id: "failed", write_paths: paths, reason: "integration fixture" }, signal, undefined, ctx) });
  } finally {
    await handlers.get("session_shutdown")();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}

for (const network of [false, true]) {
  test(`real Codex one-shot ${network ? "managed-network directory" : "offline file"} grant preserves other boundaries`, { timeout: 60_000 }, async () => {
    await fixture(network, async f => {
      const granted = join(f.root, "granted");
      if (network) mkdirSync(granted);
      else writeFileSync(granted, "original");
      const target = network ? join(granted, "output") : granted;
      const outside = join(f.root, "denied"); writeFileSync(outside, "unchanged");
      mkdirSync(join(f.cwd, ".git"));
      const script = join(f.cwd, "probe.mjs");
      writeFileSync(script, `import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
fs.appendFileSync('attempts', '1');
fs.writeFileSync(${JSON.stringify(target)}, 'approved');
fs.symlinkSync(${JSON.stringify(outside)}, 'alias');
for (const path of [${JSON.stringify(outside)}, 'alias', '.git/blocked', ${JSON.stringify(join(f.agent, "settings.json"))}]) {
  assert.throws(() => fs.writeFileSync(path, 'bad'), /EPERM|EACCES|EROFS/);
}
const child = spawnSync('/bin/bash', ['-c', 'echo bad > "$1"', 'child', ${JSON.stringify(outside)}]);
assert.notEqual(child.status, 0);
assert.equal(fs.readFileSync(${JSON.stringify(outside)}, 'utf8'), 'unchanged');
if (process.platform === 'darwin') {
  const server = net.createServer();
  server.once('error', error => { assert.match(error.code, /EPERM|EACCES/); console.log('boundaries intact'); });
  server.listen(0, '127.0.0.1', () => { server.close(); process.exitCode = 10; });
} else console.log('boundaries intact');
`);
      const command = `${quote(process.execPath)} ${quote(script)}`;
      await f.capture(command);
      assert.equal(readFileSync(join(f.cwd, "attempts"), "utf8"), "1");
      const result = await f.request([granted]);
      assert.match(result.content[0].text, /boundaries intact/);
      assert.equal(readFileSync(target, "utf8"), "approved");
      assert.equal(readFileSync(outside, "utf8"), "unchanged");
      assert.equal(readFileSync(join(f.cwd, "attempts"), "utf8"), "11", "exactly one explicitly approved retry");
      assert.equal(f.prompts, 1);
      await assert.rejects(f.request([granted]), /No eligible/);
      await assert.rejects(runProcess(f.launcher, ["-c", `echo bad > ${quote(target)}`], f.options), /not permitted|denied|read-only/i);
      assert.equal(readFileSync(target, "utf8"), "approved", "ordinary commands do not inherit the one-shot grant");
    });
  });
}

test("session navigation cancels an approved running command before returning", { timeout: 30_000 }, async () => {
  await fixture(false, async f => {
    const target = join(f.root, "granted"); writeFileSync(target, "original");
    const script = join(f.cwd, "wait.mjs");
    writeFileSync(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.writeFileSync(${JSON.stringify(target)}, 'approved');
process.on('SIGTERM', () => {});
spawn('/bin/bash', ['-c', 'trap "" TERM; echo ready > child-ready; while :; do sleep 1; done'], { stdio: 'ignore' });
fs.writeFileSync('parent-pid', String(process.pid));
setInterval(() => {}, 1000);
`);
    await f.capture(`${quote(process.execPath)} ${quote(script)}`);
    const stopped = assert.rejects(f.request([target]), /canceled/);
    try {
      for (let i = 0; i < 1000 && !existsSync(join(f.cwd, "child-ready")); i++) await delay(10);
      assert.ok(existsSync(join(f.cwd, "child-ready")), "approved command started its descendant");
      // Linux workers report a PID inside bubblewrap's namespace. Resolve its
      // host PID by the unique script argv before checking that it is reaped.
      const reportedPid = Number(readFileSync(join(f.cwd, "parent-pid"), "utf8"));
      const pid = process.platform === "linux" ? Number(readdirSync("/proc").find(entry => {
        if (!/^\d+$/.test(entry)) return false;
        try { return readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").includes(script); }
        catch (error) { if (["ENOENT", "EACCES", "ESRCH"].includes(error.code)) return false; throw error; }
      })) : reportedPid;
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "resolve the live worker's host PID");
      await f.handlers.get("session_before_switch")();
      await stopped;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(f.request([target]), /No eligible/);
    } finally { await f.handlers.get("session_shutdown")(); await stopped; }
  });
});

test("Codex deliberately protects even an explicitly granted directory root from removal", { timeout: 30_000 }, async () => {
  await fixture(false, async f => {
    const directory = join(f.root, "directory"); mkdirSync(directory);
    await f.capture(`rmdir ${quote(directory)}`);
    await assert.rejects(f.request([directory]), /not permitted|denied|busy|read-only/i);
    assert.equal(existsSync(directory), true);
    assert.equal(f.prompts, 1);
  });
});

test("actual Pi model listing fails closed: runtime lock roots cannot be granted", { timeout: 60_000 }, async () => {
  await fixture(false, async f => {
    for (const name of ["settings.json", "auth.json", "models-store.json"]) writeFileSync(join(f.agent, name), "{}");
    const command = `${quote(process.execPath)} ${quote(join(getPackageDir(), "dist/cli.js"))} --list-models --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`;
    await f.capture(command);
    const paths = ["settings.json.lock", "auth.json.lock", "models-store.json.lock"].map(name => join(f.agent, name));
    await assert.rejects(f.request(paths), /runtime\/configuration/);
    assert.equal(f.prompts, 0, "do not offer a grant that would leave unreleasable Pi locks");
    for (const path of paths) assert.equal(existsSync(path), false);
    for (const name of ["settings.json", "auth.json", "models-store.json"]) assert.equal(readFileSync(join(f.agent, name), "utf8"), "{}");
    await assert.rejects(runProcess(f.launcher, ["-c", `echo bad > ${quote(join(f.agent, "auth.json"))}`], f.options), /not permitted|denied|read-only/i);
  });
});
