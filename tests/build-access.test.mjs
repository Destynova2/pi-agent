import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuildAccess } from "../extensions/tool-policy/build-access.ts";
import { buildSourceIdentity, kvmStatus } from "../lib/build-sandbox.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t, execute) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-build-access-")));
  const cwd = join(root, "project"), agent = join(root, "agent"), home = join(root, "home");
  for (const path of [join(cwd, "ansible"), join(cwd, "packer"), join(cwd, "config"), join(agent, "scripts"), join(home, ".local/bin")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(cwd, "ansible/build.yml"), "- hosts: localhost\n  tasks: []\n");
  writeFileSync(join(cwd, "ansible.cfg"), "[defaults]\n");
  writeFileSync(join(agent, "scripts/build-worker.mjs"), "// fixture\n");
  const executable = join(home, ".local/bin/ansible-playbook");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const handlers = new Map(), tools = new Map(), commands = new Map(), calls = [], journal = [];
  let available = true, active = true;
  const ctx = { cwd, hasUI: true, ui: { select: async () => APPROVAL_CHOICES[1], notify() {} } };
  registerBuildAccess({ on: (event, fn) => handlers.set(event, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => active ? [...tools.keys()] : [], appendEntry: (type, value) => journal.push({ type, ...value }) }, agent, () => {}, {
    inspectKvm: () => available ? { available: true, device: "/dev/kvm" } : { available: false, device: "/dev/kvm", reason: "not visible on host" },
    execute: async (program, args, options) => { calls.push({ program, args, options }); return execute ? execute(program, args, options) : ""; },
  });
  t.after(async () => {
    await handlers.get("session_shutdown")();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, agent, executable, ctx, handlers, calls, commands, journal, tools, set unavailable(value) { available = !value; }, disable() { active = false; },
    request: (input = {}, signal) => tools.get("request_build_access").execute("build-test", { reason: "Build the requested image", ...input }, signal, undefined, ctx) };
}

test("build approval grants one fixed jailed invocation, bounded time and private logs", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t, async (_program, _args, options) => { options.onStdout(Buffer.from("private fixture output\n")); });
  f.ctx.ui.select = async (title, choices) => {
    assert.deepEqual(choices, APPROVAL_CHOICES.slice(0, 2));
    assert.match(title, /\/dev\/kvm/); assert.match(title, /réseau.*hôte/i);
    assert.match(title, /ansible\/build.yml/); assert.match(title, /120 min/);
    return choices[1];
  };
  const result = await f.request();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].program, "/usr/bin/bwrap");
  assert.equal(f.calls[0].options.timeoutMs, 7_200_000);
  const args = f.calls[0].args;
  assert.ok(args.includes("--unshare-all")); assert.ok(args.includes("--share-net"));
  assert.ok(args.includes("--disable-userns"));
  assert.ok(args.includes("--unshare-user"), "--disable-userns requires explicit --unshare-user, not the best-effort user namespace from --unshare-all");
  const mounts = args.flatMap((arg, i) => ["--bind", "--dev-bind"].includes(arg) ? [[arg, args[i + 1], args[i + 2]]] : []);
  assert.deepEqual(mounts.slice(0, 3), [["--dev-bind", "/dev/kvm", "/dev/kvm"], ["--bind", join(f.cwd, ".cache"), join(f.cwd, ".cache")], ["--bind", join(f.cwd, "output"), join(f.cwd, "output")]]);
  assert.equal(mounts.length, 4);
  assert.equal(args.includes("/bin/bash"), false);
  assert.equal(CONFINED_TOOLS.has("request_build_access"), false);
  assert.doesNotMatch(JSON.stringify(result), /private fixture output/);
  assert.equal(readFileSync(result.details.logPath, "utf8"), "private fixture output\n");
  assert.deepEqual(f.journal.map(entry => entry.status), ["started", "completed"]);
});

test("refusal, missing KVM, headless and delegated requests cannot start builds", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[0];
  await assert.rejects(f.request(), /not approved/);
  f.ctx.ui.select = async () => { assert.fail("remembered refusal must not prompt"); };
  await assert.rejects(f.request(), /refused earlier/);
  await f.commands.get("build-access").handler("reset", f.ctx);
  f.unavailable = true;
  await assert.rejects(f.request(), /KVM_UNAVAILABLE/);
  f.unavailable = false; f.ctx.hasUI = false;
  await assert.rejects(f.request(), /interactive parent/);
  f.ctx.hasUI = true;
  const previous = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.request(), /interactive parent/); }
  finally { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; }
  f.disable(); await assert.rejects(f.request(), /interactive parent/);
  assert.equal(f.calls.length, 0);
});

test("build inputs, executable and workspace are revalidated after consent", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  let revision = 0;
  for (const mutate of [
    () => writeFileSync(join(f.cwd, "ansible/build.yml"), `${++revision}\n`),
    () => writeFileSync(join(f.cwd, "packer/image.pkr.hcl"), `${++revision}\n`),
    () => writeFileSync(f.executable, `#!/bin/sh\n# ${++revision}\n`),
    () => { f.unavailable = true; },
  ]) {
    f.ctx.ui.select = async () => { mutate(); return APPROVAL_CHOICES[1]; };
    await assert.rejects(f.request(), /changed|KVM_UNAVAILABLE/);
  }
  assert.equal(f.calls.length, 0);
});

test("cancellation, expiration and source changes while approval is pending never dispatch", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  f.ctx.ui.select = async () => { now += 300001; return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request(), /expired/);
  let entered, answer;
  const shown = new Promise(resolve => { entered = resolve; });
  f.ctx.ui.select = () => { entered(); return new Promise(resolve => { answer = resolve; }); };
  const pending = assert.rejects(f.request(), /abort|stale|cancel/i);
  await shown;
  const closing = f.handlers.get("session_before_tree")(); answer(APPROVAL_CHOICES[1]);
  await closing; await pending;
  assert.equal(f.calls.length, 0);
});

test("a second build cannot race the approval and every completed build needs new consent", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  let entered, answer, prompts = 0;
  const shown = new Promise(resolve => { entered = resolve; });
  f.ctx.ui.select = () => { prompts++; entered(); return new Promise(resolve => { answer = resolve; }); };
  const pending = f.request(); await shown;
  await assert.rejects(f.request(), /already running/);
  answer(APPROVAL_CHOICES[1]); await pending;
  f.ctx.ui.select = async () => { prompts++; return APPROVAL_CHOICES[1]; };
  await f.request();
  assert.equal(prompts, 2); assert.equal(f.calls.length, 2);
});

test("unknown fields, command overrides, unsafe directories and durations fail closed", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  for (const input of [{ command: "sh" }, { playbook: "other.yml" }, { cwd: f.root }, { timeout_minutes: 0 }, { timeout_minutes: 241 }, { timeout_minutes: 1.5 }, { reason: "" }, { background: true }]) await assert.rejects(f.request(input));
  symlinkSync(f.root, join(f.cwd, ".cache"));
  await assert.rejects(f.request(), /links|canonical|directory/);
  rmSync(join(f.cwd, ".cache"));
  symlinkSync(join(f.root, "outside"), join(f.cwd, "config/outside.yml"));
  assert.throws(() => buildSourceIdentity(f.cwd), /links|regular/);
  assert.equal(f.calls.length, 0);
});

test("reset cancels running builds and waits for supervision; failures keep logs private", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t, async (_program, _args, options) => new Promise((_resolve, reject) => {
    options.onStderr(Buffer.from("private failure text"));
    options.signal.addEventListener("abort", () => reject(new Error("private failure text: canceled")), { once: true });
  }));
  const pending = assert.rejects(f.request(), error => /Build canceled/.test(error.message) && !error.message.includes("private failure text"));
  for (let i = 0; i < 100 && f.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  await f.handlers.get("session_before_switch")(); await pending;
  assert.deepEqual(f.journal.map(entry => entry.status), ["started", "canceled"]);
});

test("build environment excludes inherited injection, credentials and agent state", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const old = process.env.BASH_ENV; process.env.BASH_ENV = "private-injection";
  try { await f.request({ timeout_minutes: 1 }); }
  finally { if (old === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = old; }
  const args = f.calls[0].args;
  assert.ok(args.includes("--clearenv"));
  assert.equal(args.includes("private-injection"), false);
  assert.equal(args.includes("PI_CODING_AGENT_DIR"), false);
  assert.equal(f.calls[0].options.env.BASH_ENV, undefined);
  assert.equal(f.calls[0].options.timeoutMs, 60_000);
});

test("timeouts are journaled and their diagnostics stay in the private log", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t, async () => { throw new Error("fixture: deadline exceeded private timeout detail"); });
  await assert.rejects(f.request(), error => /Build timed_out/.test(error.message) && !error.message.includes("private timeout detail"));
  assert.deepEqual(f.journal.map(entry => entry.status), ["started", "timed_out"]);
  assert.match(readFileSync(f.journal.at(-1).logPath, "utf8"), /deadline exceeded private timeout detail/);
});

test("an oversized consent prompt cannot hide the full operation or the refusal choice", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  f.ctx.ui.select = async () => assert.fail("incomplete approval must not be shown");
  await assert.rejects(f.request({ reason: "界".repeat(499) }), /does not fit the terminal/);
  assert.equal(f.calls.length, 0);
});

test("host KVM check reports actual availability without claiming a successful VM", () => {
  const result = kvmStatus();
  assert.equal(result.device, "/dev/kvm");
  assert.equal(typeof result.available, "boolean");
  if (!result.available) assert.equal(typeof result.reason, "string");
});
