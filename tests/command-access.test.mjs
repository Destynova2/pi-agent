import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCommandAccess } from "../extensions/tool-policy/command-access.ts";
import { commandWritableRoots } from "../scripts/codex-shell.mjs";
import { runtimeRoot } from "../lib/runtime-paths.mjs";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";
import { metalFixture } from "./metal-fixture.mjs";

function fixture(confirm = async () => true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-command-access-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), target = join(root, "target");
  mkdirSync(join(agent, "scripts"), { recursive: true }); mkdirSync(cwd);
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home"); // Isolate the protected-cache policy from the outer sandbox's TMPDIR.
  // Unit transport only; OS confinement is exercised by command-access.integration.test.mjs.
  const handlers = new Map(), commands = new Map(); const journal = []; let tool; let prompts = 0; let active = true;
  const ctx = { cwd, hasUI: true, ui: {
    notify() {},
    confirm: (...args) => { prompts++; return confirm(...args); },
    select: async (text, choices, options) => {
      prompts++;
      assert.deepEqual(choices, APPROVAL_CHOICES);
      const answer = await confirm("Metal", text, options);
      return answer === true ? choices[1] : answer === false ? choices[0] : answer;
    },
  } };
  registerCommandAccess({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value), appendEntry: (type, data) => journal.push({ type, ...data }), registerTool: value => { tool = value; }, getActiveTools: () => active ? ["request_command_access"] : [] }, agent, () => {}, async (program, args, options) => {
    assert.equal(program, join(runtimeRoot, "scripts/codex-shell.mjs"));
    assert.equal(options.env.PI_CODING_AGENT_DIR, agent);
    options.onStdout(Buffer.from(JSON.stringify({ argv: args, cwd: options.cwd })));
    return "";
  });
  handlers.get("session_start")({}, ctx);
  const fail = (id = "failed", command = "echo original", extra = {}, isError = true) => {
    const event = { toolName: "bash", toolCallId: id, input: { command, ...extra } };
    handlers.get("tool_call")(event, ctx);
    return handlers.get("tool_result")({ ...event, content: [{ type: "text", text: "EPERM" }], isError, structuredContent: { exit_code: isError ? 1 : 0 } }, ctx);
  };
  const request = (input = {}, signal) => tool.execute("approval", { failed_call_id: "failed", write_paths: [target], reason: "write one output file", ...input }, signal, undefined, ctx);
  return { root, agent, cwd, target, ctx, handlers, commands, journal, fail, request, disable: () => { active = false; }, get prompts() { return prompts; }, close: async () => { try { await handlers.get("session_shutdown")(); } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); } } };
}

test("additional paths are canonical and narrow; runtime, links, hardlinks and ancestors are refused", async () => {
  const f = fixture();
  const validate = paths => commandWritableRoots(paths, f.cwd, f.agent);
  try {
    assert.deepEqual(validate([f.target, f.target]), [f.target]);
    assert.throws(() => validate([join(process.env.HOME, ".cache/pi-codex-sandbox/scratch")]), /runtime\/configuration/);
    for (const name of ["auth.json.lock", "settings.json.lock", "models-store.json.lock"]) assert.throws(() => validate([join(f.agent, name)]), /runtime\/configuration/);
    for (const paths of [[], Array(9).fill(f.target), ["relative"], [f.cwd], [f.root], ["/"], [f.agent], [join(f.agent, "settings.json")], [join(f.agent, "extensions")], [join(f.agent, "auth.json.lock/child")], [f.target + "/../other"], [f.target + "\n"]]) assert.throws(() => validate(paths), undefined, JSON.stringify(paths));
    symlinkSync(f.target, join(f.root, "dangling"));
    assert.throws(() => validate([join(f.root, "dangling")]), /links/);
    symlinkSync(f.agent, join(f.root, "alias"));
    assert.throws(() => validate([join(f.root, "alias/auth.json.lock")]), /links|canonical/);
    writeFileSync(f.target, "original"); linkSync(f.target, join(f.root, "hardlink"));
    assert.throws(() => validate([f.target]), /links/);
    if (existsSync(join(f.root, "AGENT"))) assert.throws(() => validate([join(f.root, "AGENT/auth.json.lock")]), /canonical/);
    assert.equal(CONFINED_TOOLS.has("request_command_access"), false, "approval must not enter child capability ceilings");
  } finally { await f.close(); }
});

test("Metal approval binds the exact command, backend and journal without granting file writes", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  let shown;
  const f = fixture(async (_title, text) => { shown = text; return true; });
  try {
    const sha256 = metalFixture(f.agent);
    f.fail("failed", "./probe 'exact argument'");
    const result = await f.request({ gpu: "metal", write_paths: undefined });
    assert.match(shown, /"gpu": "metal"/); assert.match(shown, /Deadline: 60 seconds/);
    assert.ok(shown.includes(sha256));
    const execution = JSON.parse(result.content[0].text.split("\n")[0]);
    assert.deepEqual(execution.argv, ["--metal", sha256, "-c", "./probe 'exact argument'"]);
    assert.deepEqual(result.details.writePaths, []);
    assert.deepEqual(f.journal.map(entry => entry.status), ["started", "completed"]);
    for (const entry of f.journal) {
      assert.equal(entry.type, "metal_command"); assert.equal(entry.backendSha256, sha256);
      assert.equal(entry.command, "./probe 'exact argument'"); assert.equal(entry.timeoutMs, 60000);
    }
    await assert.rejects(f.request({ gpu: "metal" }), /No eligible/);
  } finally { await f.close(); }
});

test("Metal fails before prompting when unavailable, and rejects backend replacement during approval", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  for (const mode of ["missing", "replacement", "refused"]) {
    const f = fixture(async () => {
      if (mode === "replacement") metalFixture(f.agent, "#!/bin/sh\nexit 2\n");
      return mode !== "refused";
    });
    try {
      if (mode !== "missing") metalFixture(f.agent);
      f.fail();
      await assert.rejects(f.request({ gpu: "metal", write_paths: undefined }), /unavailable|changed during approval|not approved/);
      assert.equal(f.prompts, mode === "missing" ? 0 : 1);
      assert.deepEqual(f.journal, []);
      await assert.rejects(f.request(), /No eligible/);
    } finally { await f.close(); }
  }
});

test("Metal project consent covers later commands and survives reset, without duplicate audit rows", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  const f = fixture(async () => APPROVAL_CHOICES[3]);
  try {
    metalFixture(f.agent);
    for (const command of ["./probe", "./benchmark --size 8", "./benchmark --size 16"]) {
      if (command.endsWith("16")) await f.commands.get("command-access").handler("reset", f.ctx);
      f.fail("failed", command);
      const result = await f.request({ gpu: "metal", write_paths: undefined });
      assert.equal(JSON.parse(result.content[0].text.split("\n")[0]).argv.at(-1), command);
    }
    assert.equal(f.prompts, 1);
    const db = new DatabaseSync(join(f.agent, "permission-audit/requests.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT resource, operation, source, scope, status FROM permission_requests ORDER BY rowid").all().map(row => ({ ...row })), ["human", "project", "project"].map(source => ({
        resource: "command-access", operation: "retry-metal", source, scope: "project", status: "granted",
      })));
    } finally { db.close(); }
    const other = join(f.root, "other-project"); mkdirSync(other); f.ctx.cwd = other;
    await f.handlers.get("session_start")({}, f.ctx);
    f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
    assert.equal(f.prompts, 2, "another project needs its own consent");
    f.ctx.cwd = f.cwd; await f.handlers.get("session_start")({}, f.ctx);
    metalFixture(f.agent, "#!/bin/sh\nexit 3\n");
    f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
    assert.equal(f.prompts, 3, "a different qualified backend needs new consent");
  } finally { await f.close(); }
});

test("Metal session grants expire on session changes; project grants can be revoked across processes", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  for (const scope of [2, 3]) {
    const f = fixture(async () => APPROVAL_CHOICES[scope]);
    try {
      metalFixture(f.agent);
      for (let i = 0; i < 2; i++) { f.fail(); await f.request({ gpu: "metal", write_paths: undefined }); }
      assert.equal(f.prompts, 1);
      if (scope === 2) await f.handlers.get("session_start")({}, f.ctx);
      else new McpApprovals(f.agent).revoke(f.cwd, "command-access");
      f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
      assert.equal(f.prompts, 2);
      await f.commands.get("command-access").handler("permissions", f.ctx);
      f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
      assert.equal(f.prompts, 3);
    } finally { await f.close(); }
  }
});

test("remembered Metal never grants extra filesystem writes or headless, disabled, delegated or stale execution", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  for (const mode of ["files", "headless", "disabled", "delegated", "stale"]) {
    const f = fixture(async title => title === "Metal" ? APPROVAL_CHOICES[3] : false);
    const oldChild = process.env.PI_SUBAGENT_CHILD;
    try {
      metalFixture(f.agent);
      f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
      const journalLength = f.journal.length;
      f.fail();
      if (mode === "headless") f.ctx.hasUI = false;
      if (mode === "disabled") f.disable();
      if (mode === "delegated") process.env.PI_SUBAGENT_CHILD = "1";
      if (mode === "stale") await f.handlers.get("session_start")({}, f.ctx);
      await assert.rejects(f.request({ gpu: "metal", write_paths: mode === "files" ? [f.target] : undefined }), /refused|confirmation|No eligible/);
      assert.equal(f.prompts, mode === "files" ? 2 : 1);
      assert.equal(f.journal.length, journalLength, "no additional command executed");
    } finally {
      if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
      await f.close();
    }
  }
});

test("late Metal consent expires without saving a project grant and logs one cancellation", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
  let now = Date.now(), late = true; t.mock.method(Date, "now", () => now);
  const f = fixture(async (_title, _text, options) => { if (late) now += options.timeout; return APPROVAL_CHOICES[3]; });
  try {
    metalFixture(f.agent); f.fail();
    await assert.rejects(f.request({ gpu: "metal", write_paths: undefined }), /expired/);
    assert.deepEqual(f.journal, []);
    const db = new DatabaseSync(join(f.agent, "permission-audit/requests.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT decision, status, source FROM permission_requests").all().map(row => ({ ...row })), [{ decision: "cancel", status: "cancelled", source: "unavailable" }]);
    } finally { db.close(); }
    late = false; f.fail(); await f.request({ gpu: "metal", write_paths: undefined });
    assert.equal(f.prompts, 2);
  } finally { await f.close(); }
});

test("revocation while Metal confirmation is open prevents execution and cannot restore the grant", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  let answer;
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  try {
    metalFixture(f.agent); f.fail();
    const rejected = assert.rejects(f.request({ gpu: "metal", write_paths: undefined }), /revoked/);
    await new Promise(resolve => setImmediate(resolve));
    new McpApprovals(f.agent).revoke(f.cwd, "command-access");
    answer(APPROVAL_CHOICES[3]); await rejected;
    assert.deepEqual(f.journal, []);
    f.fail(); const pending = f.request({ gpu: "metal", write_paths: undefined });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.prompts, 2);
    answer(APPROVAL_CHOICES[1]); await pending;
  } finally { await f.close(); }
});

test("only a captured foreground failure can request a one-shot retry, preserving structured results", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.request(), /No eligible/);
    assert.equal(f.fail("success", "true", {}, false), undefined);
    assert.equal(f.fail("background", "false", { background: true }), undefined);
    assert.equal(f.fail("oversized", "x".repeat(2001)), undefined);
    const result = f.fail();
    assert.deepEqual(result.structuredContent, { exit_code: 1 });
    assert.match(result.content.at(-1).text, /failed_call_id="failed"/);
    const approved = await f.request();
    const execution = JSON.parse(approved.content[0].text.split("\n")[0]);
    assert.deepEqual(execution, { argv: ["--write-roots", JSON.stringify([f.target]), "-c", "echo original"], cwd: f.cwd });
    await assert.rejects(f.request(), /No eligible/);
    assert.equal(f.prompts, 1);
  } finally { await f.close(); }
});

test("approval snapshots command, paths and reason and cannot be changed while awaiting the human", async () => {
  let answer, shown;
  const f = fixture((_title, text) => { shown = text; return new Promise(resolve => { answer = resolve; }); });
  try {
    f.fail();
    const paths = [f.target];
    const input = { write_paths: paths, reason: "initial reason" };
    const pending = f.request(input);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(shown, /echo original/); assert.match(shown, /initial reason/);
    paths[0] = f.agent; input.reason = "replacement";
    answer(true);
    const result = await pending;
    assert.deepEqual(result.details.writePaths, [f.target]);
    assert.equal(f.prompts, 1);
  } finally { await f.close(); }
});

test("refusal, headless, disabled tool, pre-abort and stale cwd never execute", async () => {
  for (const mode of ["refuse", "headless", "disabled", "abort", "cwd"]) {
    const f = fixture(async () => false);
    try {
      f.fail();
      if (mode === "headless") f.ctx.hasUI = false;
      if (mode === "disabled") f.disable();
      if (mode === "cwd") f.ctx.cwd = f.root;
      await assert.rejects(f.request({}, mode === "abort" ? AbortSignal.abort() : undefined), /refused|confirmation|abort|stale/i);
      await assert.rejects(f.request(), /No eligible/);
      assert.equal(f.prompts, mode === "refuse" ? 1 : 0);
    } finally { await f.close(); }
  }
});

test("session transitions and cancellation invalidate waiting approvals even if the UI answers late", async () => {
  for (const mode of ["abort", "session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
    let answer;
    const f = fixture(() => new Promise(resolve => { answer = resolve; }));
    try {
      f.fail();
      const controller = new AbortController();
      const rejected = assert.rejects(f.request({}, controller.signal), /abort|stale/i);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === "abort") controller.abort();
      else await f.handlers.get(mode)({}, f.ctx);
      answer(true);
      await rejected;
      await assert.rejects(f.request(), /No eligible/);
    } finally { await f.close(); }
  }
});

test("expired failures, changed commands and results arriving after a session reset cannot be retried", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    f.fail(); now += 300_001;
    await assert.rejects(f.request(), /expired/);
    const event = { toolName: "bash", toolCallId: "changed", input: { command: "original" } };
    f.handlers.get("tool_call")(event, f.ctx);
    event.input.command = "different";
    assert.equal(f.handlers.get("tool_result")({ ...event, isError: true }, f.ctx), undefined);
    f.handlers.get("tool_call")(event, f.ctx);
    await f.handlers.get("session_start")({}, f.ctx);
    assert.equal(f.handlers.get("tool_result")({ ...event, isError: true }, f.ctx), undefined);
    await assert.rejects(f.request({ failed_call_id: "changed" }), /No eligible/);
    assert.equal(f.prompts, 0);
  } finally { await f.close(); }
});

test("expired confirmation is recorded as cancellation, even if a late answer says yes", async t => {
  for (const answer of [false, true]) {
    await t.test(String(answer), async t => {
      let now = Date.now(); t.mock.method(Date, "now", () => now);
      const f = fixture(async (_title, _text, options) => { now += options.timeout; return answer; });
      try {
        f.fail(); now += 9000;
        await assert.rejects(f.request(), /expired after five minutes; no operation performed/);
        await assert.rejects(f.request(), /No eligible/);
        const db = new DatabaseSync(join(f.agent, "permission-audit/requests.sqlite"), { readOnly: true });
        try {
          const row = db.prepare("SELECT decision, status, source FROM permission_requests ORDER BY rowid LIMIT 1").get();
          assert.deepEqual({ ...row }, { decision: "cancel", status: "cancelled", source: "unavailable" });
          assert.equal(db.prepare("SELECT count(*) AS count FROM audit_events WHERE kind='permission.expired'").get().count, 1);
        } finally { db.close(); }
        assert.equal(f.prompts, 1); assert.deepEqual(f.journal, []);
      } finally { await f.close(); }
    });
  }
});

test("new failures remain eligible after tree navigation or canceled session navigation", async () => {
  const f = fixture();
  try {
    for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"]) {
      f.fail("old");
      await f.handlers.get(event)();
      f.handlers.get("before_agent_start")({}, f.ctx);
      await assert.rejects(f.request({ failed_call_id: "old" }), /No eligible/);
      f.fail("new");
      assert.match((await f.request({ failed_call_id: "new" })).content[0].text, /One-shot access consumed/);
    }
  } finally { await f.close(); }
});

test("paths are checked again after approval and simultaneous requests serialize their prompts", async () => {
  const answers = [];
  const f = fixture(() => new Promise(resolve => answers.push(resolve)));
  try {
    f.fail("one"); f.fail("two");
    const first = assert.rejects(f.request({ failed_call_id: "one" }), /links/);
    const second = assert.rejects(f.request({ failed_call_id: "two", write_paths: [join(f.root, "other")] }), /refused/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.prompts, 1);
    symlinkSync(join(f.agent, "settings.json"), f.target);
    answers[0](true);
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.prompts, 2);
    answers[1](false);
    await second;
  } finally { await f.close(); }
});
