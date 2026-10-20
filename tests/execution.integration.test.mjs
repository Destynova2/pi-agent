import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runProcess } from "../lib/process.ts";
import { prepareExecution } from "../lib/execution-plan.ts";
import { sandboxBackend, executionBinding } from "../scripts/codex-shell.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-execution-native-"))), cwd = join(root, "project"), agent = join(root, "agent"), output = join(root, "output"), home = join(root, "home");
  for (const path of [cwd, agent, output, home, join(agent, "scripts")]) mkdirSync(path, { recursive: true });
  for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
  const launcher = join(agent, "scripts/codex-shell.mjs");chmodSync(launcher, 0o755);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: realpathSync(sandboxBackend()) };
  delete env.PI_CODEX_NETWORK_GRANTS;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command, profile) => spawnSync(launcher, profile ? ["--execution-profile", JSON.stringify({ ...profile, binding: executionBinding(cwd, profile.writePaths) }), "-c", command] : ["-c", command], { cwd, env, encoding: "utf8", timeout: 30000 });
  return { root, cwd, agent, output, launcher, env, run };
}

test("native generic profile combines scoped writes/network and protects nested metadata without a lasting grant", { timeout: 90000, skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  mkdirSync(join(f.output, "nested/.git"), { recursive: true });writeFileSync(join(f.output, "nested/.git/config"), "keep");
  writeFileSync(join(f.agent, "network-policy.json"), JSON.stringify({ allow: [] }));
  const target = join(f.output, "artifact");
  const command = `printf artifact > ${quote(target)}; if printf bad > ${quote(join(f.output, "nested/.git/config"))} 2>/dev/null; then exit 91; fi; curl --noproxy '' --fail --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/`;
  const result = f.run(command, { hosts: ["registry.npmjs.org"], writePaths: [f.output] });
  assert.ifError(result.error);assert.equal(result.status, 0, result.stderr);assert.equal(result.stdout, "200");
  assert.equal(readFileSync(target, "utf8"), "artifact");assert.equal(readFileSync(join(f.output, "nested/.git/config"), "utf8"), "keep");
  const moved = f.run(`mv ${quote(join(f.output, "nested"))} ${quote(join(f.output, "renamed"))} && printf bad > ${quote(join(f.output, "renamed/.git/config"))}`, { hosts: [], writePaths: [f.output] });
  assert.notEqual(moved.status, 0);
  // Linux follows the read-only inode after a permitted parent rename.
  const protectedConfig = ["nested/.git/config", "renamed/.git/config"].map(path => join(f.output, path)).filter(existsSync);
  assert.equal(protectedConfig.length, 1);assert.equal(readFileSync(protectedConfig[0], "utf8"), "keep");
  const denied = f.run(`printf bad > ${quote(join(f.output, "later"))}`);
  assert.notEqual(denied.status, 0);assert.equal(existsSync(join(f.output, "later")), false);
  const offline = f.run("curl --noproxy '' --fail --silent --show-error --max-time 5 https://registry.npmjs.org/", { hosts: [], writePaths: [] });
  assert.notEqual(offline.status, 0);
  const other = f.run("curl --noproxy '' --fail --silent --show-error --max-time 5 https://example.com/", { hosts: ["registry.npmjs.org"], writePaths: [] });
  assert.notEqual(other.status, 0);assert.match(other.stderr, /403|blocked/i);
});

for (const profile of ["workspace", "isolated"]) test(`native ${profile} session cancellation reaps a detached child`, { timeout: 60000, skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);writeFileSync(join(f.cwd, "input"), "source");
  const marker = `pi-execution-${randomUUID()}`;
  const script = "import os,socket,time; " + (profile === "isolated" ? "s=socket.socket(socket.AF_UNIX); s.bind('/tmp/private.sock'); " : "") + "p=os.fork(); os.setsid() if p==0 else None; print('detached-ready' if p==0 else 'parent-ready',flush=True); time.sleep(60)";
  const command = `/usr/bin/python3 -c ${quote(script)} ${quote(marker)}`;
  const plan = prepareExecution({ command, reason: "qualify cancellation", profile, ...(profile === "isolated" ? { inputs: ["input"] } : {}), background: true, timeout_ms: 10000 }, f.cwd, f.agent);
  t.after(plan.dispose);
  const abort = new AbortController();let output = "", children = [];
  const owned = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(name => {
    try { return readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(marker); } catch { return false; }
  });
  const launch = plan.launch();
  await assert.rejects(runProcess(launch.program, launch.args, { ...launch.options, env: { ...f.env, ...launch.options.env }, signal: abort.signal, onStdout: chunk => {
    output += chunk;
    if (output.includes("detached-ready")) { children = owned(); abort.abort(); }
  } }), /canceled/);
  assert.match(output, /detached-ready/);assert.ok(children.length >= 2, "parent and detached child were actually running");
  for (const pid of children) {
    let state;
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(state === undefined || state === 'Z', `owned process ${pid} survived cancellation (${state})`);
  }
});

test("native generic launch strips inherited secrets and rechecks the reviewed cwd after chdir", { timeout: 30000, skip: process.platform !== "linux" }, t => {
  const f = fixture(t); f.env.PI_EXECUTION_SECRET = "must-not-leak";f.env.GH_TOKEN = "must-not-leak";
  const clean = f.run('test -z "${PI_EXECUTION_SECRET-}" && test -z "${GH_TOKEN-}"', { hosts: [], writePaths: [] });
  assert.equal(clean.status, 0, clean.stderr);
  const binding = executionBinding(f.cwd, []);
  binding.cwd[2] += 1;
  const denied = spawnSync(f.launcher, ["--execution-profile", JSON.stringify({ hosts: [], writePaths: [], binding }), "-c", "touch must-not-exist"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
  assert.notEqual(denied.status, 0);assert.match(denied.stderr, /STALE_EXECUTION/);assert.equal(existsSync(join(f.cwd, "must-not-exist")), false);
});


test("native launch rejects replaced directory and symlink roots before command dispatch", { timeout: 30000, skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const binding = executionBinding(f.cwd, [f.output]);
  renameSync(f.output, join(f.root, "old-output"));
  symlinkSync(f.agent, f.output);
  const result = spawnSync(f.launcher, ["--execution-profile", JSON.stringify({ hosts: [], writePaths: [f.output], binding }), "-c", "touch must-not-exist"], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);assert.match(result.stderr, /canonical|unlinked|STALE_EXECUTION/);assert.equal(existsSync(join(f.cwd, "must-not-exist")), false);
  rmSync(f.output);mkdirSync(f.output);
  const replaced = spawnSync(f.launcher, ["--execution-profile", JSON.stringify({ hosts: [], writePaths: [f.output], binding }), "-c", "touch must-not-exist"], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(replaced.status, 0);assert.match(replaced.stderr, /STALE_EXECUTION/);assert.equal(existsSync(join(f.cwd, "must-not-exist")), false);
});


test("native launch rejects metadata changed after review", { timeout: 30000, skip: process.platform !== "linux" }, t => {
  const f = fixture(t), binding = executionBinding(f.cwd, []);
  mkdirSync(join(f.cwd, "nested/.git"), { recursive: true });
  const result = spawnSync(f.launcher, ["--execution-profile", JSON.stringify({ hosts: [], writePaths: [], binding }), "-c", "touch must-not-exist"], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);assert.match(result.stderr, /STALE_EXECUTION/);assert.equal(existsSync(join(f.cwd, "must-not-exist")), false);
});

test("native workspace lock is exclusive across brokers and released after completion", { timeout: 30000, skip: process.platform !== "linux" }, async t => {
  const f = fixture(t); let ready;const started = new Promise(resolve => { ready = resolve; });
  const first = prepareExecution({ command: "echo locked; sleep 2", reason: "qualify shared lock" }, f.cwd, f.agent).launch();
  const running = runProcess(first.program, first.args, { ...first.options, env: { ...f.env, ...first.options.env }, onStdout: chunk => { if (chunk.toString().includes("locked")) ready(); } });
  await Promise.race([started, running.then(() => { throw new Error("lock fixture exited before readiness"); })]);
  const second = prepareExecution({ command: "touch lock-result", reason: "qualify shared lock" }, f.cwd, f.agent).launch();
  try {
    await assert.rejects(runProcess(second.program, second.args, { ...second.options, env: { ...f.env, ...second.options.env } }));
    assert.equal(existsSync(join(f.cwd, "lock-result")), false);
  } finally { await running; }
  await runProcess(second.program, second.args, { ...second.options, env: { ...f.env, ...second.options.env } });
  assert.equal(existsSync(join(f.cwd, "lock-result")), true);
});
