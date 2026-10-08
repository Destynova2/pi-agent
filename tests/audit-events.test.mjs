import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registerAudit } from "../extensions/audit/index.ts";
import { appendAuditEvent, auditContext } from "../lib/audit-events.ts";
import { auditReport, formatAuditReport } from "../lib/audit-report.ts";
import { redactAudit } from "../lib/audit-redaction.ts";
import { PermissionAudit } from "../lib/permission-audit.ts";
import { McpApprovals, APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-audit-events-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), commands = new Map(), notices = [], fallback = [];
  let session = "session-one";
  const ui = { select: async (_title, choices) => choices[1], confirm: async () => false, input: async () => "user answer",
    editor: async (_title, prefill) => prefill, custom: async () => ({ token: "opaque-secret" }), notify: text => notices.push(text) };
  const original = { ...ui };
  const ctx = { cwd, hasUI: true, mode: "tui", ui, getSystemPrompt: () => "System instructions", sessionManager: {
    getSessionId: () => session, getSessionFile: () => join(root, `${session}.jsonl`),
  } };
  registerAudit({ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand: (name, command) => commands.set(name, command), appendEntry: (kind, value) => fallback.push({ kind, value }) }, agent);
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const events = () => {
    const db = new DatabaseSync(join(agent, "permission-audit/requests.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT * FROM audit_events ORDER BY sequence").all().map(row => ({ ...row, payload: JSON.parse(row.payload_json) })); }
    finally { db.close(); }
  };
  return { root, agent, cwd, ctx, emit, events, original, notices, commands, fallback, setSession: value => { session = value; } };
}

test("structured dialogs retain text, choices, answers and permission/tool correlation", async t => {
  const f = fixture(t); await f.emit("session_start");
  await f.emit("before_agent_start", { prompt: "Build the demo\nPreserve the volumes" });
  await f.emit("agent_start");
  await f.emit("tool_call", { toolName: "request_podman_access", toolCallId: "call-1", input: { args: ["ps"] } });
  const approvals = new McpApprovals(f.agent);
  await approvals.authorize(f.ctx, { resource: "podman-access", auditOperation: "ps", toolCallId: "call-1", identity: "local", operation: "ps",
    title: "Autoriser Podman ?", detail: "Inspecter les conteneurs", remember: true, revalidate() {} });
  await f.emit("tool_execution_end", { toolName: "request_podman_access", toolCallId: "call-1", isError: true, result: { content: [{ type: "text", text: "Podman connection refused" }] } });
  await f.ctx.ui.confirm("Delete a file?", "file.txt");
  await f.ctx.ui.input("Choose a name", "example");
  await f.ctx.ui.editor("Edit text", "two\nlines");
  const custom = await f.ctx.ui.custom(() => ({}));
  assert.deepEqual(custom, { token: "opaque-secret" });
  f.ctx.ui.notify("Early validation refused: worktree is shared", "error");
  const events = f.events(), dialog = events.find(e => e.kind === "dialog.open");
  assert.match(dialog.payload.title, /Autoriser Podman/);
  assert.deepEqual(dialog.payload.content.choices, APPROVAL_CHOICES);
  assert.equal(dialog.tool_call_id, "call-1"); assert.ok(dialog.request_id);
  const answer = events.find(e => e.kind === "dialog.answer");
  assert.equal(answer.dialog_id, dialog.dialog_id); assert.equal(answer.request_id, dialog.request_id);
  assert.equal(answer.payload.response, APPROVAL_CHOICES[1]);
  assert.equal(events.find(e => e.kind === "dialog.answer" && e.payload.kind === "confirm").payload.outcome, "negative-or-dismissed");
  assert.equal(events.find(e => e.kind === "dialog.answer" && e.payload.kind === "input").payload.response, "user answer");
  assert.equal(events.find(e => e.kind === "dialog.answer" && e.payload.kind === "editor").payload.response, "two\nlines");
  assert.equal(events.find(e => e.kind === "ui.notification").payload.type, "error");
  assert.doesNotMatch(JSON.stringify(events), /opaque-secret/);
  const report = auditReport(f.agent, { cwd: f.cwd, events: 100 });
  assert.deepEqual(report.executions.map(r => ({ ...r })), [{ outcome: "failed", count: 1 }]);
  assert.equal(report.coverage.opaque_dialogs, 1); assert.equal(report.unansweredDialogs, 0);
  assert.match(formatAuditReport(report), /failed=1/);
  assert.equal(report.summary.requests, 1); assert.equal(report.permissions[0].status, "granted");
});

test("redaction removes known secrets before persistence and marks omitted or bounded content", async t => {
  const f = fixture(t); await f.emit("session_start");
  const secrets = ["json-value", "shell-value", "flag-value", "header-value", "userpass", "query-value", "fragment-value", "key-material", "image-pixels", "hidden-reasoning"];
  await f.emit("message_end", { message: { role: "user", content: [
    { type: "text", text: 'API_TOKEN=shell-value curl --password flag-value\nAuthorization: Bearer header-value\nhttps://alice:userpass@example.com/path?q=query-value#fragment-value\n-----BEGIN RSA PRIVATE KEY-----\nkey-material\n-----END RSA PRIVATE KEY-----' },
    { type: "text", text: JSON.stringify({ password: "json-value" }) },
    { type: "image", data: "image-pixels", mimeType: "image/png" }, { type: "thinking", thinking: "hidden-reasoning" },
  ] } });
  await f.ctx.ui.editor("API token", "editor-credential");
  f.ctx.ui.notify('Request failed: {"authorization":"notice-secret"}', "error");
  const stored = readFileSync(join(f.agent, "permission-audit/requests.sqlite"));
  for (const secret of [...secrets, "editor-credential", "notice-secret"]) assert.equal(stored.includes(Buffer.from(secret)), false, secret);
  assert.equal(statSync(join(f.agent, "permission-audit")).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.agent, "permission-audit/requests.sqlite")).mode & 0o777, 0o600);
  const bounded = redactAudit({ large: "x".repeat(40000), input: { env: { CUSTOM_KEY: "private" }, stdin: "private" }, cycle: null });
  assert.equal(bounded.truncated, true); assert.ok(bounded.redactions >= 2); assert.doesNotMatch(JSON.stringify(bounded), /private/);
  const circular = {}; circular.self = circular;
  assert.equal(redactAudit(circular).truncated, true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(redactAudit({ huge: "x".repeat(1100000) }))));
});

test("concurrent dialogs keep their original request and session even after navigation", async t => {
  const f = fixture(t), pending = [];
  f.ctx.ui.select = (title) => new Promise(resolve => pending.push({ title, resolve }));
  await f.emit("session_start");
  const first = new PermissionAudit(f.agent, f.ctx, { resource: "one", operation: "run", toolCallId: "tool-one" });
  const second = new PermissionAudit(f.agent, f.ctx, { resource: "two", operation: "run", toolCallId: "tool-two" });
  const a = first.run(() => f.ctx.ui.select("One", ["no", "yes"]));
  const b = second.run(() => f.ctx.ui.select("Two", ["no", "yes"]));
  f.setSession("session-two");
  pending[1].resolve("no"); await b; pending[0].resolve("yes"); await a;
  const answers = f.events().filter(e => e.kind === "dialog.answer");
  assert.deepEqual(answers.map(e => [e.tool_call_id, e.session_id, e.payload.response]), [["tool-two", "session-one", "no"], ["tool-one", "session-one", "yes"]]);
  assert.notEqual(answers[0].request_id, answers[1].request_id);
  assert.equal(auditReport(f.agent, { sessionId: "session-two" }).coverage.events, 0);
});

test("dialog errors, aborts, storage failures, recovery and reload are observable without duplicate wrappers", async t => {
  const f = fixture(t);
  const failure = new Error("Dialog unavailable");
  f.ctx.ui.input = async () => { throw failure; };
  await f.emit("session_start"); await f.emit("session_start");
  await assert.rejects(f.ctx.ui.input("Enter a name"), error => error === failure);
  const controller = new AbortController(); controller.abort();
  await f.ctx.ui.confirm("Confirm", "message", { signal: controller.signal });
  assert.equal(f.events().filter(e => e.kind === "dialog.open").length, 2);
  assert.equal(f.events().find(e => e.kind === "dialog.error").payload.error.message, failure.message);
  assert.equal(f.events().find(e => e.kind === "dialog.answer").payload.outcome, "aborted");
  const dbPath = join(f.agent, "permission-audit/requests.sqlite");
  chmodSync(dbPath, 0o644);
  const before = f.notices.length;
  f.ctx.ui.notify("Still show the refusal", "error");
  assert.equal(f.notices.length, before + 1); assert.equal(f.fallback.length, 1);
  await assert.rejects(f.ctx.ui.confirm("Cannot record consent", "message"), /Unsafe permission audit/);
  chmodSync(dbPath, 0o600);
  await f.emit("input", { text: "recover" });
  assert.equal(f.events().filter(e => e.kind === "audit.gap").length, 1);
  await f.emit("session_shutdown");
  assert.equal(f.ctx.ui.select, f.original.select);
  await f.emit("session_start"); await f.ctx.ui.select("Reloaded", ["no", "yes"]);
  assert.equal(f.events().filter(e => e.kind === "dialog.open" && e.payload.title === "Reloaded").length, 1);
});

test("report preserves historical unknowns, includes live WAL and never backfills dialogs or writes grants", async t => {
  const f = fixture(t);
  assert.equal(auditReport(f.agent).available, false);
  assert.equal(existsSync(join(f.agent, "permission-audit")), false);
  const prior = new PermissionAudit(f.agent, f.ctx, { resource: "legacy", operation: "run", toolCallId: "old" });
  prior.finish("granted", "human", "once");
  let report = auditReport(f.agent, { cwd: f.cwd });
  assert.equal(report.coverage.events, 0); assert.equal(report.executions[0].outcome, "unobserved");
  const writer = new DatabaseSync(join(f.agent, "permission-audit/requests.sqlite"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    appendAuditEvent(f.agent, auditContext(f.ctx), "tool.end", { isError: false });
    assert.ok(existsSync(join(f.agent, "permission-audit/requests.sqlite-wal")));
    report = auditReport(f.agent, { cwd: f.cwd, events: 1 });
    assert.equal(report.coverage.events, 1); assert.equal(report.executions[0].outcome, "unobserved", "unlinked success must not certify the old permission");
    assert.equal(report.timeline.length, 1);
  } finally { writer.close(); }
  assert.equal(existsSync(join(f.agent, "mcp-approvals")), false);
  assert.throws(() => auditReport(f.agent, { events: -1 }), /limit/);
  assert.throws(() => auditReport(f.agent, { since: "yesterday" }), /ISO/);
  const cli = spawnSync(process.execPath, ["scripts/audit-report.mjs", "--target", f.agent, "--project", f.cwd, "--json", "--events", "1"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).timeline.length, 1);
});
