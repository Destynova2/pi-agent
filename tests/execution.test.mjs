import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executionCapabilities, prepareExecution } from "../lib/execution-plan.ts";
import { commandWritableRoots, executionProfile, executionReadOnlyRoots, executionEnvironment } from "../scripts/codex-shell.mjs";
import { executionFixture } from "./execution-fixture.mjs";
import { openAuditDatabase } from "../lib/audit-storage.ts";

test("generic run combines exact hosts/writes in one automatic review without inherited grants", async t => {
  const f = executionFixture(t), output = join(f.root, "output");
  f.policy({ allow: ["baseline.example.com"], deny: [] });
  await f.run({ hosts: ["REGISTRY.NPMJS.ORG"], write_paths: [output] });
  assert.equal(f.reviews.length, 1); assert.equal(f.runs.length, 1);
  const detail = JSON.parse(JSON.parse(f.reviews[0].messages[0].content).action.detail);
  assert.deepEqual(detail.hosts, ["registry.npmjs.org"]); assert.deepEqual(detail.writePaths, [output]);
  assert.match(detail.capabilities.filesystem, /baseline host reads/);
  const { binding, ...resources } = JSON.parse(f.runs[0].args[f.runs[0].args.indexOf("--execution-profile") + 1]);
  assert.deepEqual(resources, { hosts: ["registry.npmjs.org"], writePaths: [output] });
  assert.equal(binding.cwd[0], f.cwd);
  await f.run();
  assert.equal(f.reviews.length, 2); assert.deepEqual(JSON.parse(f.runs[1].args[f.runs[1].args.indexOf("--execution-profile") + 1]).hosts, []); assert.deepEqual(JSON.parse(f.runs[1].args[f.runs[1].args.indexOf("--execution-profile") + 1]).writePaths, []);
  assert.equal(readdirSync(f.agent).includes("network-grants"), false);
});

test("capabilities are read-only, platform-aware and unsupported combinations never run", async t => {
  const f = executionFixture(t);
  assert.equal((await f.call({ action: "capabilities" })).details.profiles.workspace.supported, process.platform === "linux");
  assert.equal(f.reviews.length, 0); assert.equal(f.runs.length, 0);
  assert.equal(executionCapabilities("darwin").profiles.isolated.supported, false);
  assert.equal(executionCapabilities("darwin").profiles.workspace.supported, false);
  assert.deepEqual(executionCapabilities("darwin").lifetimes, []);
  for (const extra of [{ devices: ["/dev/kvm"] }, { lifetime: "leased" }, { timeout_ms: 121000 }, { profile: "other" }, { inputs: ["src"] }, { profile: "isolated", hosts: ["example.com"] }]) await assert.rejects(f.run(extra));
  assert.equal(f.reviews.length, 0); assert.equal(f.runs.length, 0);
});

test("explicit denies, manual policy, uncertain verdicts and unavailable reviewer never fall back", async t => {
  const f = executionFixture(t);
  f.policy({ allow: [], deny: ["blocked.example.com"] });
  await assert.rejects(f.run({ hosts: ["blocked.example.com"] }), /policy_denied/);
  assert.equal(f.reviews.length, 0);
  f.verdict = { decision: "ask", category: "insufficient_context" };
  await assert.rejects(f.run(), /Automatic approval refused/);
  f.verdict = { decision: "allow", category: "within_scope" };
  await f.manual(); await assert.rejects(f.run(), /manual policy/);
  assert.equal(f.runs.length, 0);
});

test("changed policy, cwd identities and new user restrictions invalidate pending review", async t => {
  for (const change of ["policy", "cwd", "user", "cancel", "session"]) await t.test(change, async t => {
    const f = executionFixture(t), abort = new AbortController();
    f.review = async () => {
      if (change === "policy") f.policy({ allow: [], deny: ["example.com"] });
      if (change === "cwd") { renameSync(f.cwd, join(f.root, "old")); mkdirSync(f.cwd); }
      if (change === "user") f.messages.push({ type: "message", message: { role: "user", content: "Stop now" } });
      if (change === "cancel") abort.abort();
      if (change === "session") f.ctx.sessionManager.getSessionId = () => "other";
      return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] };
    };
    await assert.rejects(f.run({ hosts: ["example.com"] }, abort.signal), /stale|revoked|abort|canceled/i);
    assert.equal(f.runs.length, 0);
  });
});

test("extra writes reject protected paths, links and workspace ancestors; nested metadata is protected", async t => {
  const f = executionFixture(t), output = join(f.root, "output");
  mkdirSync(join(output, "nested/.git"), { recursive: true });
  writeFileSync(join(output, "nested/.git/config"), "untouched");
  for (const path of [f.agent, f.root, join(output, "nested/.git/config")]) await assert.rejects(f.run({ write_paths: [path] }));
  symlinkSync(f.agent, join(output, "alias")); await assert.rejects(f.run({ write_paths: [join(output, "alias")] }));
  assert.ok(executionReadOnlyRoots([output]).includes(join(output, "nested/.git")));
  assert.throws(() => executionProfile({ hosts: [], writePaths: [], privateNetwork: true }));
  assert.throws(() => executionProfile({ hosts: ["localhost"], writePaths: [] }));
  assert.equal(f.runs.length, 0);
});

test("an exact sibling cwd is reviewed without moving the parent session", async t => {
  const f = executionFixture(t), other = join(f.root, "other");mkdirSync(other);
  await f.run({ cwd: other });
  assert.equal(f.runs[0].options.cwd, other); assert.equal(f.ctx.cwd, f.cwd);
  assert.match(f.reviews[0].messages[0].content, /other/);
});

test("session jobs return owned handles, report completion, and stop without a second permission", async t => {
  let began, finish, ended = false;
  const started = new Promise(resolve => { began = resolve; });
  const f = executionFixture(t, { execute: async (_program, _args, options) => {
    began(); options.onStdout(Buffer.from("ready"));
    await new Promise(resolve => { finish = resolve; options.signal.addEventListener("abort", () => { ended = true; resolve(); }, { once: true }); });
    return "";
  } });
  const result = await f.run({ background: true });await started;
  assert.equal(result.details.state, "running");
  assert.equal((await f.call({ action: "status", job_id: result.details.id })).details.output, "ready");
  await assert.rejects(f.call({ action: "stop", job_id: "unowned" }), /Unknown job/);
  assert.equal(ended, false);
  const stopped = await f.call({ action: "stop", job_id: result.details.id });
  assert.equal(stopped.details.state, "stopped");assert.equal(ended, true);assert.equal(f.reviews.length, 1);
  assert.equal(f.notices.length, 1);assert.match(f.notices[0].content, /stopped/);
  await f.handlers.get("session_before_switch")();
  await assert.rejects(f.call({ action: "status", job_id: result.details.id }), /Unknown job/);
  finish();
});

test("session rotation joins cancellation before discarding jobs and suppresses old notifications", async t => {
  let ended = false;
  const f = executionFixture(t, { execute: async (_program, _args, options) => {
    await new Promise(resolve => options.signal.addEventListener("abort", () => { ended = true; resolve(); }, { once: true }));return "";
  } });
  const { details } = await f.run({ background: true });
  await f.handlers.get("session_before_fork")();
  assert.equal(ended, true);assert.equal(f.notices.length, 0);
  await assert.rejects(f.call({ action: "status", job_id: details.id }));
});

test("isolated planning pins copies and always disposes them after denied review", { skip: process.platform !== "linux" }, async t => {
  const { snapshotCommand } = await import("../lib/isolated-command.ts");
  const f = executionFixture(t, { prepare: (request, cwd, agent) => prepareExecution(request, cwd, agent, { platform: "linux", backend: () => process.execPath,
    runtime: () => ({ backend: "/usr/bin/bwrap", roots: ["/usr/bin"], aliases: [] }), snapshot: snapshotCommand }) });
  writeFileSync(join(f.cwd, "input"), "original");
  f.verdict = { decision: "deny", category: "out_of_scope" };
  await assert.rejects(f.run({ profile: "isolated", inputs: ["input"] }));
  assert.deepEqual(readdirSync(join(f.agent, "isolated-jobs")), []);assert.equal(f.runs.length, 0);
  assert.equal(readFileSync(join(f.cwd, "input"), "utf8"), "original");
});

test("unavailable review and unknown request fields never reach an executor", async t => {
  const f = executionFixture(t);
  f.review = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(f.run(), /Automatic approval refused/);
  assert.equal(f.runs.length, 0);
});

test("concurrent session jobs remain bounded, independent and are all reaped on shutdown", async t => {
  const ended = [];
  const f = executionFixture(t, { execute: async (_program, args, options) => {
    await new Promise(resolve => options.signal.addEventListener("abort", () => { ended.push(args.at(-1)); resolve(); }, { once: true })); return "";
  } });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const cwd = join(f.root, `job-${i}`);mkdirSync(cwd);
    ids.push((await f.run({ cwd, command: `echo job-${i}`, background: true })).details.id);
  }
  await assert.rejects(f.run({ background: true }), /resource_limit/);
  assert.equal(f.reviews.length, 4);
  await f.call({ action: "stop", job_id: ids[1] });
  assert.deepEqual(ended, ["echo job-1"]);
  assert.equal((await f.call({ action: "status", job_id: ids[0] })).details.state, "running");
  await f.handlers.get("session_shutdown")();assert.equal(ended.length, 4);
});

test("review cannot silently change an extra write root to a replacement directory", async t => {
  const f = executionFixture(t), output = join(f.root, "output");
  f.review = async () => {
    renameSync(output, join(f.root, "old-output"));mkdirSync(output);
    return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] };
  };
  await assert.rejects(f.run({ write_paths: [output] }), /stale_request/);assert.equal(f.runs.length, 0);
});

test("host executable selectors, config and startup files cannot become writable capabilities", async t => {
  const f = executionFixture(t);
  for (const name of [".local/bin", ".local/share/pi-codex", ".bashrc", ".gitconfig", ".config", ".local/share/pi-runtime"]) {
    assert.throws(() => commandWritableRoots([join(homedir(), name)], f.cwd, f.agent), /runtime|configuration/);
  }
  const env = executionEnvironment({ PATH: "/usr/bin", HOME: "/home/test", GH_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", SSH_AUTH_SOCK: "/run/agent", DBUS_SESSION_BUS_ADDRESS: "secret", NODE_OPTIONS: "--import evil", BASH_ENV: "evil" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/test" });
});

test("notifications contain no untrusted command output and nested writable jobs conflict", async t => {
  const f = executionFixture(t, { execute: async (_program, _args, options) => {
    options.onStdout(Buffer.from("UNTRUSTED OUTPUT"));
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));return "";
  } });
  const sub = join(f.root, "output/sub");mkdirSync(sub);
  const first = await f.run({ write_paths: [join(f.root, "output")], background: true });
  await assert.rejects(f.run({ cwd: sub, background: true }), /resource_conflict/);
  await assert.rejects(f.run({ background: true }), /resource_conflict/);
  await f.call({ action: "stop", job_id: first.details.id });
  assert.doesNotMatch(f.notices[0].content, /UNTRUSTED OUTPUT/);
  assert.match((await f.call({ action: "status", job_id: first.details.id })).details.output, /UNTRUSTED OUTPUT/);
});


test("pending reviews and foreground commands reserve capacity and release it on completion", async t => {
  let release;const waiting = new Promise(resolve => { release = resolve; });
  const f = executionFixture(t, { execute: async () => { await waiting;return ""; } });
  let allow;const verdict = new Promise(resolve => { allow = resolve; });
  f.review = async () => { await verdict;return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] }; };
  const running = [];
  try {
    for (let i = 0; i < 4; i++) {
      const cwd = join(f.root, `foreground-${i}`);mkdirSync(cwd);
      running.push(f.run({ cwd }));
    }
    await assert.rejects(f.run(), /resource_limit/);
    allow();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.run(), /resource_limit/);
  } finally { allow();release();await Promise.all(running); }
  f.review = undefined;
  await f.run();
});

test("oversized launch payload and metadata sets fail before review", async t => {
  const f = executionFixture(t);
  // Each path stays under PATH_MAX (1024 on macOS) while eight of them, listed twice in the profile, exceed 16 KiB.
  const parts = []; for (let fill = 1016 - Buffer.byteLength(f.root) - "/file-0".length; fill > 1;) { const n = Math.min(127, Math.floor((fill - 1) / 2)); parts.push("é".repeat(n)); fill -= 2 * n + 1; }
  const base = join(f.root, ...parts);mkdirSync(base, { recursive: true });
  const roots = Array.from({ length: 8 }, (_, i) => join(base, `file-${i}`));
  for (const path of roots) writeFileSync(path, "");
  await assert.rejects(f.run({ write_paths: roots }), /16 KiB/);assert.equal(f.reviews.length, 0);
  for (let i = 0; i < 200; i++) mkdirSync(join(f.root, `output/repository-${i}/.git`), { recursive: true });
  await assert.rejects(f.run({ write_paths: [join(f.root, "output")] }), /bounded profile size/);assert.equal(f.reviews.length, 0);
});

test("audit distinguishes authorization from execution failure and denial releases its reservation", async t => {
  const f = executionFixture(t, { execute: async () => { throw new Error("command failed"); } });
  f.verdict = { decision: "deny", category: "out_of_scope" };
  await assert.rejects(f.run());
  f.verdict = { decision: "allow", category: "within_scope" };
  f.messages.push({ type: "message", message: { role: "user", content: "Run the new independent check now." } });
  await assert.rejects(f.run({ command: "printf new-check" }), /command failed/);
  const db = openAuditDatabase(f.agent, f.cwd);
  try {
    assert.deepEqual(db.prepare("SELECT status FROM permission_requests ORDER BY rowid").all().map(row => row.status), ["denied", "granted"]);
    const events = db.prepare("SELECT kind, payload_json FROM audit_events WHERE kind LIKE 'execution.%' ORDER BY sequence").all();
    assert.deepEqual(events.map(row => row.kind), ["execution.started", "execution.finished"]);
    assert.equal(JSON.parse(events[1].payload_json).state, "failed");
  } finally { db.close(); }
});
