import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PermissionAudit } from "../lib/permission-audit.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";
import { registerNetworkAccess } from "../extensions/tool-policy/network.ts";
import { registerCommandAccess } from "../extensions/tool-policy/command-access.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-permission-audit-test-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(agent, "permission-audit/requests.sqlite");
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/session.jsonl" }, ui: {} };
  const rows = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare("SELECT * FROM permission_requests ORDER BY rowid").all().map(row => ({ ...row })); }
    finally { db.close(); }
  };
  const request = { resource: "mcp:fixture", auditOperation: "read", toolCallId: "call-mcp", identity: "fixture", operation: "read", title: "Read", detail: "private-argument", remember: true, revalidate() {} };
  return { root, agent, cwd, database, ctx, rows, request };
}

test("request and prompt persist before the answer; a reopened database retains session, scope and decision", async t => {
  const f = fixture(t);
  let answer;
  f.ctx.ui.select = async () => {
    const [row] = f.rows();
    assert.equal(row.status, "pending");
    assert.ok(row.prompted_at);
    assert.equal(row.answered_at, null);
    return new Promise(resolve => { answer = resolve; });
  };
  const pending = new McpApprovals(f.agent).authorize(f.ctx, f.request);
  await new Promise(resolve => setImmediate(resolve));
  answer(APPROVAL_CHOICES[2]);
  const ticket = await pending; ticket();
  const [row] = f.rows();
  assert.equal(row.session_id, "session-1");
  assert.equal(row.session_file, "/session.jsonl");
  assert.equal(row.cwd, f.cwd);
  assert.equal(row.resource, "mcp:fixture");
  assert.equal(row.operation, "read");
  assert.equal(row.tool_call_id, "call-mcp");
  assert.equal(row.status, "granted");
  assert.equal(row.source, "human");
  assert.equal(row.decision, "allow");
  assert.equal(row.scope, "session");
  assert.ok(row.completed_at >= row.answered_at && row.answered_at >= row.requested_at);
  assert.equal(statSync(f.database).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.agent, "permission-audit")).mode & 0o777, 0o700);
});

test("remembered grants and cached refusals are distinct from human decisions", async t => {
  const f = fixture(t), approvals = new McpApprovals(f.agent);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[2];
  await approvals.authorize(f.ctx, f.request);
  await approvals.authorize(f.ctx, f.request);
  approvals.reset();
  f.ctx.ui.select = async () => APPROVAL_CHOICES[3];
  await approvals.authorize(f.ctx, f.request);
  await new McpApprovals(f.agent).authorize(f.ctx, f.request);
  const denied = { ...f.request, operation: "refuse" };
  f.ctx.ui.select = async () => APPROVAL_CHOICES[0];
  await assert.rejects(approvals.authorize(f.ctx, denied), /not approved/);
  await assert.rejects(approvals.authorize(f.ctx, denied), /refused earlier/);
  assert.deepEqual(f.rows().map(({ status, source, scope, decision }) => [status, source, scope, decision]), [
    ["granted", "human", "session", "allow"], ["granted", "session", "session", null],
    ["granted", "human", "project", "allow"], ["granted", "project", "project", null],
    ["denied", "human", "once", "deny"], ["denied", "refusal_cache", null, null],
  ]);
});

test("dismissal, abort, stale approval and headless denial do not become grants", async t => {
  const f = fixture(t), approvals = new McpApprovals(f.agent);
  f.ctx.ui.select = async () => undefined;
  await assert.rejects(approvals.authorize(f.ctx, f.request));
  approvals.reset();
  const controller = new AbortController();
  f.ctx.ui.select = async () => { controller.abort(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(approvals.authorize(f.ctx, f.request, controller.signal));
  f.ctx.ui.select = async () => { approvals.reset(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(approvals.authorize(f.ctx, f.request), /stale/);
  f.ctx.hasUI = false;
  await assert.rejects(approvals.authorize(f.ctx, f.request), /human approval/);
  assert.deepEqual(f.rows().map(row => [row.status, row.decision]), [
    ["cancelled", "cancel"], ["cancelled", "allow"], ["error", "allow"], ["denied", null],
  ]);
  assert.equal(f.rows().at(-1).source, "unavailable");
});

test("raw commands, serialized operations, arguments, titles, reasons and errors never enter SQLite", async t => {
  const f = fixture(t);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[1];
  const secret = "private-token-123456789";
  await new McpApprovals(f.agent).authorize(f.ctx, { ...f.request, operation: JSON.stringify({ password: secret }), title: secret, detail: secret, identity: secret });
  await assert.rejects(new McpApprovals(f.agent).authorize(f.ctx, { ...f.request, revalidate() { throw new Error(secret); } }));
  assert.doesNotMatch(JSON.stringify(f.rows()), /private-token|private-argument/);
  assert.equal(readFileSync(f.database).includes(Buffer.from(secret)), false);
  assert.match(f.rows()[0].request_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(f.rows()[0].request_sha256, f.rows()[1].request_sha256);
});

test("unsafe audit files and unsupported schemas stop before a prompt or grant", async t => {
  for (const kind of ["symlink", "hardlink", "public", "sidecar-link", "sidecar-hardlink", "sidecar-public", "directory-link", "version"]) {
    await t.test(kind, async t => {
      const f = fixture(t), directory = join(f.agent, "permission-audit");
      mkdirSync(directory, { mode: 0o700 });
      const target = join(f.cwd, "target");
      writeFileSync(target, "keep", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, f.database);
      if (kind === "hardlink") linkSync(target, f.database);
      if (kind === "public") writeFileSync(f.database, "", { mode: 0o644 });
      if (kind === "sidecar-link") symlinkSync(target, f.database + "-wal");
      if (kind === "sidecar-hardlink") linkSync(target, f.database + "-wal");
      if (kind === "sidecar-public") writeFileSync(f.database + "-wal", "", { mode: 0o644 });
      if (kind === "directory-link") { rmSync(directory, { recursive: true }); symlinkSync(f.cwd, directory); }
      if (kind === "version") {
        const audit = new PermissionAudit(f.agent, f.ctx, { resource: "fixture", operation: "setup" });
        audit.finish("denied");
        const db = new DatabaseSync(f.database); db.exec("PRAGMA user_version=999"); db.close();
      }
      f.ctx.ui.select = async () => assert.fail("No approval when audit cannot be saved");
      await assert.rejects(new McpApprovals(f.agent).authorize(f.ctx, f.request));
      assert.equal(readFileSync(target, "utf8"), "keep");
    });
  }
});

test("an answer cannot grant access when the audit storage becomes unavailable during a prompt", async t => {
  const f = fixture(t);
  f.ctx.ui.select = async () => { chmodSync(f.database, 0o644); return APPROVAL_CHOICES[3]; };
  await assert.rejects(new McpApprovals(f.agent).authorize(f.ctx, f.request), /Unsafe permission audit/);
  chmodSync(f.database, 0o600);
  assert.equal(f.rows()[0].status, "pending", "an incomplete record must not pretend that a grant was issued");
  f.ctx.hasUI = false;
  await assert.rejects(new McpApprovals(f.agent).authorize(f.ctx, f.request), /human approval/);
});

test("simultaneous processes share one SQLite journal without losing or mixing requests", async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./fixtures/permission-audit-worker.mjs", import.meta.url).pathname, f.agent, f.cwd]);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const rows = f.rows();
  assert.equal(rows.length, 48);
  assert.equal(new Set(rows.map(row => row.id)).size, 48);
  assert.equal(new Set(rows.map(row => row.pid)).size, 4);
  assert.ok(rows.every(row => row.status === "granted" && row.decision === "allow" && row.completed_at));
});

test("network requests record baseline, new and reused grants, explicit denies, refusal and cancellation", async t => {
  const f = fixture(t), handlers = new Map(); let tool, answer = true;
  const old = process.env.PI_CODEX_NETWORK_GRANTS;
  writeFileSync(join(f.agent, "network-policy.json"), JSON.stringify({ allow: ["base.example.com"], deny: ["deny.example.com"] }));
  f.ctx.ui.confirm = async () => answer;
  registerNetworkAccess({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; } }, f.agent, () => {}, async () => { throw new Error("fixture exit 2"); });
  handlers.get("session_start")({}, f.ctx);
  t.after(() => { handlers.get("session_shutdown")(); if (old === undefined) delete process.env.PI_CODEX_NETWORK_GRANTS; else process.env.PI_CODEX_NETWORK_GRANTS = old; });
  const request = host => tool.execute("call-network", { hosts: [host], reason: "private reason" }, undefined, undefined, f.ctx);
  await request("base.example.com");
  await request("new.example.com");
  await request("new.example.com");
  await assert.rejects(request("deny.example.com"));
  answer = false;
  await assert.rejects(request("refuse.example.com"));
  f.ctx.ui.confirm = async () => { handlers.get("session_start")({}, f.ctx); return true; };
  await assert.rejects(request("stale.example.com"));
  assert.deepEqual(f.rows().map(row => [row.status, row.source, row.decision]), [
    ["granted", "policy", null], ["granted", "human", "allow"], ["granted", "session", null],
    ["denied", "policy", null], ["denied", "human", "deny"], ["error", "human", "allow"],
  ]);
  assert.ok(f.rows().every(row => row.tool_call_id === "call-network"));
  assert.equal(f.rows()[1].targets_json, '["new.example.com"]');
});

test("command approval is recorded before execution and execution failure does not erase consent", async t => {
  const f = fixture(t), handlers = new Map(); let tool;
  f.ctx.ui.confirm = async () => true;
  registerCommandAccess({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: value => { tool = value; }, getActiveTools: () => ["request_command_access"] }, f.agent, () => {}, async () => { throw new Error("fixture exit 2"); });
  handlers.get("session_start")({}, f.ctx);
  t.after(() => handlers.get("session_shutdown")());
  const event = { toolName: "bash", toolCallId: "failed-call", input: { command: "secret command" } };
  handlers.get("tool_call")(event, f.ctx);
  handlers.get("tool_result")({ ...event, content: [], isError: true }, f.ctx);
  await assert.rejects(tool.execute("retry-call", { failed_call_id: "failed-call", write_paths: [join(f.root, "output")], reason: "private reason" }, undefined, undefined, f.ctx), /One-shot access consumed/);
  assert.equal(f.rows()[0].status, "granted");
  assert.equal(f.rows()[0].tool_call_id, "retry-call");
  assert.doesNotMatch(JSON.stringify(f.rows()), /secret command|private reason/);
});
