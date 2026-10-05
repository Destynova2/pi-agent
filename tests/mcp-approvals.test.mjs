import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_CHOICES, McpApprovals, fingerprint, serverIdentity } from "../lib/mcp-approvals.ts";
import { McpConnection } from "../extensions/mcp/client.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-approvals-")));
  const agent = join(root, "agent"), cwd = join(root, "workspace");
  mkdirSync(agent); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let prompts = 0, choice = APPROVAL_CHOICES[1];
  const ctx = { cwd, hasUI: true, ui: {
    select: async (_title, options) => { prompts++; assert.deepEqual(options, options.length === 4 ? APPROVAL_CHOICES : APPROVAL_CHOICES.slice(0, 2)); return choice; },
  } };
  const request = { resource: "mcp:fixture", identity: "configuration-1", operation: "read", title: "Fixture", detail: "Read-only", remember: true, revalidate() {} };
  return { root, agent, cwd, ctx, request, approvals: new McpApprovals(agent), prompts: () => prompts, choose: value => { choice = value; } };
}

test("once, session and project grants have different lifetimes; scope includes project, server, operation and configuration", async t => {
  const f = fixture(t);
  await f.approvals.authorize(f.ctx, f.request);
  await f.approvals.authorize(f.ctx, f.request);
  assert.equal(f.prompts(), 2, "once never becomes a cache entry");
  f.choose(APPROVAL_CHOICES[2]);
  await f.approvals.authorize(f.ctx, f.request);
  await f.approvals.authorize(f.ctx, f.request);
  assert.equal(f.prompts(), 3);
  f.approvals.reset();
  await f.approvals.authorize(f.ctx, f.request);
  assert.equal(f.prompts(), 4, "session reset discards session grants");
  await new McpApprovals(f.agent).authorize(f.ctx, f.request);
  assert.equal(f.prompts(), 5, "session grants never leak to another instance");
  f.approvals.reset(); f.choose(APPROVAL_CHOICES[3]);
  await f.approvals.authorize(f.ctx, f.request);
  const next = new McpApprovals(f.agent);
  f.ctx.hasUI = false;
  const ticket = await next.authorize(f.ctx, f.request); ticket();
  assert.equal(f.prompts(), 6, "explicit project grant survives restart and permits confined headless reads");
  await assert.rejects(next.authorize(f.ctx, { ...f.request, identity: "configuration-2" }), /human approval/);
  await assert.rejects(next.authorize(f.ctx, { ...f.request, operation: "other" }), /human approval/);
  await assert.rejects(next.authorize(f.ctx, { ...f.request, resource: "mcp:other" }), /human approval/);
  await assert.rejects(next.authorize(f.ctx, { ...f.request, interactiveOnly: true }), /interactive parent/);
  const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere);
  await assert.rejects(next.authorize({ ...f.ctx, cwd: elsewhere }, f.request), /human approval/);
  const alias = join(f.root, "alias"); symlinkSync(f.cwd, alias);
  await next.authorize({ ...f.ctx, cwd: alias }, f.request);
  f.ctx.hasUI = true; f.choose(APPROVAL_CHOICES[1]);
  await next.authorize(f.ctx, { ...f.request, remember: false });
  await next.authorize(f.ctx, { ...f.request, remember: false });
  assert.equal(f.prompts(), 8, "non-read operations cannot consume or create remembered grants");
  f.choose(APPROVAL_CHOICES[3]);
  await assert.rejects(next.authorize(f.ctx, { ...f.request, remember: false }), /not approved/, "an answer outside the offered choices cannot widen scope");
});

test("revocation crosses instances and invalidates saved and session tickets, including approvals pending in another instance", async t => {
  const f = fixture(t);
  f.choose(APPROVAL_CHOICES[3]);
  const ticket = await f.approvals.authorize(f.ctx, f.request);
  const other = new McpApprovals(f.agent);
  const sessionRequest = { ...f.request, operation: "session" };
  f.choose(APPROVAL_CHOICES[2]);
  const sessionTicket = await other.authorize(f.ctx, sessionRequest);
  let decide, entered;
  const shown = new Promise(resolve => { entered = resolve; });
  f.ctx.ui.select = () => { entered(); return new Promise(resolve => { decide = resolve; }); };
  const pending = other.authorize(f.ctx, { ...f.request, operation: "pending" });
  await shown;
  f.approvals.revoke(f.cwd, f.request.resource);
  assert.throws(ticket, /revoked/); assert.throws(sessionTicket, /revoked/);
  decide(APPROVAL_CHOICES[3]);
  await assert.rejects(pending, /revoked/);
  f.ctx.hasUI = false;
  await assert.rejects(other.authorize(f.ctx, f.request), /human approval/);
  await assert.rejects(other.authorize(f.ctx, sessionRequest), /human approval/);
});

test("refusal does not nag; aborted, stale and changed-configuration answers create no permission", async t => {
  const f = fixture(t);
  f.choose(APPROVAL_CHOICES[0]);
  await assert.rejects(f.approvals.authorize(f.ctx, f.request), /not approved/);
  await assert.rejects(f.approvals.authorize(f.ctx, f.request), /refused earlier/);
  assert.equal(f.prompts(), 1);
  f.approvals.reset();
  for (const invalidate of [() => f.approvals.reset(), controller => controller.abort(), () => { f.ctx.cwd = f.root; }]) {
    const controller = new AbortController();
    f.ctx.ui.select = async () => { invalidate(controller); return APPROVAL_CHOICES[3]; };
    await assert.rejects(f.approvals.authorize(f.ctx, f.request, controller.signal));
    f.ctx.cwd = f.cwd;
  }
  let valid = true;
  f.ctx.ui.select = async () => { valid = false; return APPROVAL_CHOICES[3]; };
  await assert.rejects(f.approvals.authorize(f.ctx, { ...f.request, revalidate: () => { if (!valid) throw new Error("changed config"); } }), /changed config/);
  assert.deepEqual(readdirSync(f.agent), [], "failed approvals never create private grant files");
});

test("parallel requests share only remembered consent and preserve complete request display", async t => {
  const f = fixture(t);
  let prompts = 0;
  f.ctx.ui.select = async title => { prompts++; assert.match(title, /\\u001b/); assert.match(title, /\\u202e/); return APPROVAL_CHOICES[2]; };
  const request = { ...f.request, title: "server\u001b[2J\u202e" };
  await Promise.all([f.approvals.authorize(f.ctx, request), f.approvals.authorize(f.ctx, request)]);
  assert.equal(prompts, 1);
  f.approvals.reset();
  f.ctx.ui.select = async () => { prompts++; return APPROVAL_CHOICES[1]; };
  await Promise.all([f.approvals.authorize(f.ctx, request), f.approvals.authorize(f.ctx, request)]);
  assert.equal(prompts, 3);
});

test("stored grants exclude arguments and secrets; unsafe storage fails closed", async t => {
  const f = fixture(t);
  f.choose(APPROVAL_CHOICES[3]);
  await f.approvals.authorize(f.ctx, { ...f.request, identity: fingerprint({ token: "private-token" }), detail: "private-argument" });
  const directory = join(f.agent, "mcp-approvals", fingerprint(f.cwd), fingerprint(f.request.resource));
  const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json")));
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /private-token|private-argument/);
  const fresh = new McpApprovals(f.agent);
  const request = { ...f.request, identity: fingerprint({ token: "private-token" }) };
  chmodSync(path, 0o666);
  await assert.rejects(fresh.authorize(f.ctx, request), /Unsafe MCP approval file/);
  chmodSync(path, 0o600); writeFileSync(path, "{}");
  await assert.rejects(fresh.authorize(f.ctx, request), /Invalid MCP approval/);
  rmSync(path); symlinkSync(join(f.cwd, "forged"), path);
  writeFileSync(join(f.cwd, "forged"), raw, { mode: 0o600 });
  await assert.rejects(fresh.authorize(f.ctx, request));
  rmSync(directory, { recursive: true }); symlinkSync(f.cwd, directory);
  await assert.rejects(fresh.authorize(f.ctx, request), /Unsafe MCP approval directory/);
  await assert.rejects(fresh.authorize({ ...f.ctx, cwd: f.root }, request), /outside/);
});

test("server identity follows executable resolution and configured arguments, not mutable data files", t => {
  const f = fixture(t), data = join(f.cwd, "data.db");
  assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }), "object key order is not a permission change");
  assert.notEqual(fingerprint(["--one", "--two"]), fingerprint(["--two", "--one"]), "argument order remains significant");
  writeFileSync(data, "first");
  const before = serverIdentity(process.execPath, ["--database", data], f.cwd);
  writeFileSync(data, "second-version");
  assert.equal(fingerprint(before), fingerprint(serverIdentity(process.execPath, ["--database", data], f.cwd)), "normal server data writes must not invalidate consent");
  assert.notEqual(fingerprint(before), fingerprint(serverIdentity(process.execPath, ["--database", "other.db"], f.cwd)));
  const alias = join(f.root, "node"); symlinkSync(process.execPath, alias);
  assert.equal(serverIdentity("node", [], f.cwd, { PATH: f.root }).command, realpathSync(process.execPath));
  assert.throws(() => serverIdentity("missing", [], f.cwd, { PATH: f.root }), /not found/);
});

test("the client refreshes declarations before guarded dispatch and rejects ambiguous names", async () => {
  let catalog = [{ name: "read", annotations: { readOnlyHint: true } }];
  const calls = [];
  const transport = { start() {}, notify() {}, request: async method => {
    calls.push(method);
    return method === "tools/list" ? { tools: structuredClone(catalog) } : {};
  } };
  const connection = new McpConnection(transport);
  await connection.start();
  const manifest = fingerprint(connection.tools[0]);
  catalog[0].annotations.readOnlyHint = false;
  await assert.rejects(connection.call("read", {}, undefined, () => {
    assert.equal(fingerprint(connection.tools[0]), manifest, "changed declaration cannot consume old consent");
  }), /changed declaration/);
  assert.equal(calls.filter(method => method === "tools/list").length, 2);
  assert.equal(calls.includes("tools/call"), false);
  catalog = [{ name: "duplicate" }, { name: "duplicate" }];
  await assert.rejects(new McpConnection(transport).start(), /Ambiguous/);
});

test("revocation while a server starts is checked before the actual tool dispatch", async t => {
  const f = fixture(t);
  f.choose(APPROVAL_CHOICES[2]);
  const ticket = await f.approvals.authorize(f.ctx, f.request);
  let entered, finish;
  const shown = new Promise(resolve => { entered = resolve; });
  const initialized = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const connection = new McpConnection({ start() {}, notify() {}, request: async method => {
    calls.push(method);
    if (method === "initialize") { entered(); await initialized; return {}; }
    return { tools: [{ name: "read" }] };
  } });
  const pending = connection.call("read", {}, undefined, ticket);
  await shown;
  new McpApprovals(f.agent).revoke(f.cwd, f.request.resource);
  finish();
  await assert.rejects(pending, /revoked/);
  assert.equal(calls.includes("tools/call"), false);
});
