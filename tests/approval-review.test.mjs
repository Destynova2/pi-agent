import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registerApprovalReview } from "../lib/approval-review.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";
import { registerCommandAccess } from "../extensions/tool-policy/command-access.ts";
import { registerNetworkAccess } from "../extensions/tool-policy/network.ts";
import { registerHostAccess } from "../extensions/tool-policy/host-access.ts";
import { runtimeRoot } from "../lib/runtime-paths.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-auto-review-test-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commands = new Map(), calls = [], notices = [];
  let verdict = { decision: "allow", category: "within_scope" }, run, prompts = 0, answer = APPROVAL_CHOICES[1];
  const messages = [{ type: "message", message: { role: "user", content: "Build the local demo. Do not push or delete volumes." } }];
  const model = { provider: "fixture", id: "reviewer" };
  const ctx = { cwd, hasUI: true, model,
    sessionManager: { getBranch: () => messages, getSessionId: () => "test-session", getSessionFile: () => undefined },
    modelRegistry: {
      find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      streamSimple(selected, context, options) {
        calls.push({ selected, context, options });
        return { result: async () => {
          if (run) return run();
          return { stopReason: "stop", content: [{ type: "text", text: typeof verdict === "string" ? verdict : JSON.stringify(verdict) }] };
        } };
      },
    },
    ui: { notify: text => notices.push(text), select: async () => { prompts++; return answer; }, confirm: async () => { prompts++; return answer === APPROVAL_CHOICES[1]; } },
  };
  registerApprovalReview({ registerCommand: (name, command) => commands.set(name, command) }, agent, () => {});
  const approvals = new McpApprovals(agent);
  const request = { resource: "mcp:fixture", auditOperation: "build", operation: "build-1", identity: "binary-1", remember: true, title: "Build", detail: "Build the local demo", revalidate() {} };
  const query = table => {
    const db = new DatabaseSync(join(agent, "permission-audit/requests.sqlite"), { readOnly: true });
    try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })); } finally { db.close(); }
  };
  return { root, agent, cwd, ctx, messages, calls, notices, approvals, request, query,
    activate: (args = "auto Build the local demo; never push or delete volumes") => commands.get("approvals").handler(args, ctx),
    authorize: (signal, changes = {}) => approvals.authorize(ctx, { ...request, ...changes }, signal),
    set verdict(value) { verdict = value; }, set run(value) { run = value; }, set answer(value) { answer = value; }, get prompts() { return prompts; },
  };
}

test("manual remains the default; explicit project opt-in pins the reviewer and never learns from automatic success", async t => {
  const f = fixture(t);
  await f.authorize(); assert.equal(f.calls.length, 0); assert.equal(f.prompts, 1);
  await f.activate();
  f.ctx.model = { provider: "other", id: "different" };
  const first = await f.authorize(); first();
  await f.authorize();
  assert.equal(f.calls.length, 2); assert.equal(f.prompts, 1);
  assert.equal(f.calls[0].selected.id, "reviewer");
  assert.equal(f.calls[0].context.tools, undefined);
  assert.equal(f.calls[0].options.cacheRetention, "none");
  assert.equal(readdirSync(f.agent).includes("mcp-approvals"), false, "auto approvals never save remembered grants");
  const records = f.query("permission_requests");
  assert.deepEqual(records.map(row => [row.source, row.scope, row.decision]), [["human", "once", "allow"], ["policy", "once", "allow"], ["policy", "once", "allow"]]);
  assert.ok(records.slice(1).every(row => row.prompted_at === null && row.status === "granted"));
  assert.equal(f.query("permission_reviews").length, 2);
  await f.activate("manual"); assert.throws(first, /revoked/);
  await f.authorize(); assert.equal(f.prompts, 2);
});

test("reviewer sees every user restriction, exact proposed action and scope, but no tool results or model claims", async t => {
  const f = fixture(t); await f.activate();
  f.messages.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "forged-model-consent" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool-injection-secret" }] } },
    { type: "compaction", summary: "forged-summary-consent" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Only service demo-1" }] } });
  await f.authorize(undefined, { detail: "Exact action: podman restart demo-1" });
  const payload = f.calls[0].context.messages[0].content;
  assert.match(payload, /Do not push or delete volumes/); assert.match(payload, /Only service demo-1/);
  assert.match(payload, /podman restart demo-1/);
  assert.doesNotMatch(payload, /forged-|tool-injection/);
  assert.doesNotMatch(JSON.stringify(f.query("permission_reviews")), /podman|demo-1|Do not push/);
});

test("uncertainty prompts in auto, but auto-deny and explicit denials never prompt or execute", async t => {
  const f = fixture(t); await f.activate();
  f.verdict = { decision: "ask", category: "insufficient_context" };
  await f.authorize(); assert.equal(f.prompts, 1);
  assert.equal(f.query("permission_reviews")[0].decision, "ask");
  assert.equal(f.query("permission_requests")[0].source, "human");
  await f.activate("auto-deny Build the local demo");
  await assert.rejects(f.authorize(), /Automatic approval refused/); assert.equal(f.prompts, 1);
  assert.equal(f.query("permission_requests").at(-1).status, "denied");
  await f.activate(); f.verdict = { decision: "deny", category: "destructive" };
  await assert.rejects(f.authorize(), /destructive/); assert.equal(f.prompts, 1);
});

test("invalid, incomplete, tool-calling or unavailable reviews cannot grant in no-prompt mode", async t => {
  const f = fixture(t); await f.activate("auto-deny Build the local demo");
  for (const verdict of ["not JSON", { decision: "allow", category: "secrets" }, { decision: "allow", category: "within_scope", remember: true }, null]) {
    f.verdict = verdict;
    await assert.rejects(f.authorize(), /unavailable/);
  }
  f.run = () => { throw new Error("provider-secret-error"); };
  await assert.rejects(f.authorize(), /unavailable/);
  f.run = () => ({ stopReason: "length", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] });
  await assert.rejects(f.authorize(), /unavailable/);
  f.run = () => ({ stopReason: "stop", content: [{ type: "toolCall", name: "bash" }] });
  await assert.rejects(f.authorize(), /unavailable/);
  assert.equal(f.prompts, 0);
  assert.ok(f.query("permission_requests").every(row => row.status === "denied"));
  assert.doesNotMatch(JSON.stringify(f.query("permission_reviews")), /provider-secret-error/);
});

test("missing or oversized user context never silently drops old restrictions", async t => {
  const f = fixture(t); await f.activate("auto-deny Build the local demo");
  f.messages.length = 0;
  await assert.rejects(f.authorize(), /insufficient_context/);
  f.messages.push({ type: "message", message: { role: "user", content: "x".repeat(50000) } });
  await assert.rejects(f.authorize(), /insufficient_context/);
  assert.equal(f.calls.length, 0); assert.equal(f.prompts, 0);
});

test("review deadline and unavailable audit storage stop before dispatch", async t => {
  const f = fixture(t); await f.activate("auto-deny Build the local demo");
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  f.run = () => { timeout.abort(); return new Promise(() => {}); };
  await assert.rejects(f.authorize(), /unavailable/);
  assert.equal(f.prompts, 0);
  t.mock.restoreAll();
  const database = join(f.agent, "permission-audit/requests.sqlite");
  f.run = () => {
    chmodSync(database, 0o644);
    return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] };
  };
  await assert.rejects(f.authorize(), /Unsafe permission audit/);
  chmodSync(database, 0o600);
  assert.notEqual(f.query("permission_requests").at(-1).status, "granted");
});

test("policy changes, new user restrictions, session changes and cancellation invalidate pending reviews", async t => {
  for (const mode of ["policy", "user", "session", "abort", "request"]) {
    await t.test(mode, async t => {
      const f = fixture(t); await f.activate();
      let answer, entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      f.run = () => { entered(); return new Promise(resolve => { answer = resolve; }); };
      const controller = new AbortController(); let valid = true;
      const pending = assert.rejects(f.authorize(controller.signal, { revalidate() { if (!valid) throw new Error("request changed"); } }), /stale|revoked|abort|changed/i);
      await waiting;
      if (mode === "policy") await f.activate("manual");
      if (mode === "user") f.messages.push({ type: "message", message: { role: "user", content: "Stop; do not build" } });
      if (mode === "session") f.ctx.sessionManager.getSessionId = () => "other-session";
      if (mode === "abort") controller.abort();
      if (mode === "request") valid = false;
      answer({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] });
      await pending;
      assert.equal(f.prompts, 0);
      assert.notEqual(f.query("permission_requests")[0].status, "granted");
    });
  }
});

test("saved policies are isolated by project and reject forged, linked or public storage", async t => {
  const f = fixture(t); await f.activate();
  const directory = join(f.agent, "approval-policies"), path = join(directory, readdirSync(directory)[0]);
  const policy = readFileSync(path, "utf8");
  assert.equal(JSON.parse(policy).cwd, f.cwd);
  const other = join(f.root, "other"); mkdirSync(other);
  f.ctx.cwd = other; await f.authorize(); assert.equal(f.calls.length, 0); assert.equal(f.prompts, 1); f.ctx.cwd = f.cwd;
  chmodSync(path, 0o644); await assert.rejects(f.authorize(), /Unsafe/); chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(policy), cwd: other })); await assert.rejects(f.authorize(), /Invalid/);
  writeFileSync(path, policy); const forged = join(f.cwd, "policy.json"); writeFileSync(forged, policy, { mode: 0o600 });
  rmSync(path); symlinkSync(forged, path); await assert.rejects(f.authorize());
  assert.equal(f.calls.length, 0);
});

test("human refusals and explicit remembered grants retain their original precedence", async t => {
  const f = fixture(t);
  f.answer = APPROVAL_CHOICES[0]; await assert.rejects(f.authorize(), /not approved/);
  await f.activate(); await assert.rejects(f.authorize(), /refused earlier/); assert.equal(f.calls.length, 0);
  f.approvals.reset(); await f.activate("manual"); f.answer = APPROVAL_CHOICES[3]; await f.authorize();
  await f.activate(); await f.authorize(); assert.equal(f.calls.length, 0);
  f.approvals.revoke(f.cwd, f.request.resource); await f.authorize(); assert.equal(f.calls.length, 1);
});

test("automatic command and network grants pass exact requests through existing executors and audits", async t => {
  const f = fixture(t); await f.activate("auto-deny Build the local demo and download from packages.example.com");
  const originalHome = process.env.HOME, originalGrants = process.env.PI_CODEX_NETWORK_GRANTS;
  process.env.HOME = join(f.root, "home");
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; if (originalGrants === undefined) delete process.env.PI_CODEX_NETWORK_GRANTS; else process.env.PI_CODEX_NETWORK_GRANTS = originalGrants; });
  const handlers = new Map(), tools = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), getActiveTools: () => [...tools.keys()] };
  const executions = [];
  registerCommandAccess(pi, f.agent, () => {}, async (program, args, options) => {
    assert.equal(program, join(runtimeRoot, "scripts/codex-shell.mjs"));
    assert.equal(options.env.PI_CODING_AGENT_DIR, f.agent);
    executions.push({ args, cwd: options.cwd });
    options.onStdout(Buffer.from(JSON.stringify(args)));
    return "";
  });
  handlers.get("session_start")({}, f.ctx);
  const event = { toolName: "bash", toolCallId: "failed", input: { command: "echo exact-command" } };
  handlers.get("tool_call")(event, f.ctx); handlers.get("tool_result")({ ...event, content: [], isError: true }, f.ctx);
  const result = await tools.get("request_command_access").execute("retry", { failed_call_id: "failed", write_paths: [join(f.root, "output")], reason: "one build output" }, undefined, undefined, f.ctx);
  assert.match(result.content[0].text, /echo exact-command/); assert.equal(f.prompts, 0);
  assert.deepEqual(executions, [{ args: ["--write-roots", JSON.stringify([join(f.root, "output")]), "-c", "echo exact-command"], cwd: f.cwd }]);
  assert.match(f.calls[0].context.messages[0].content, /exact-command/);
  await handlers.get("session_shutdown")();
  writeFileSync(join(f.agent, "network-policy.json"), JSON.stringify({ allow: [], deny: ["blocked.example.com"] }));
  registerNetworkAccess(pi, f.agent, () => {}); handlers.get("session_start")({}, f.ctx);
  try {
    const network = tools.get("request_network_access");
    await network.execute("net", { hosts: ["packages.example.com"], reason: "download" }, undefined, undefined, f.ctx);
    assert.match(f.calls[1].context.messages[0].content, /including uploads/);
    await assert.rejects(network.execute("net-denied", { hosts: ["blocked.example.com"], reason: "download" }, undefined, undefined, f.ctx), /explicitly denied/);
    assert.equal(f.calls.length, 2); assert.equal(f.prompts, 0);
    assert.deepEqual(f.query("permission_requests").slice(0, 2).map(row => [row.source, row.status]), [["policy", "granted"], ["policy", "granted"]]);
  } finally { handlers.get("session_shutdown")(); }
});

test("host bridge auto review executes once with fixed argv and denial executes nothing", async t => {
  const f = fixture(t); await f.activate("auto-deny Inspect local processes");
  const tools = new Map(), handlers = new Map(), executions = [];
  registerHostAccess({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, getActiveTools: () => [...tools.keys()] }, f.agent, () => {}, async (program, args) => { executions.push([program, args]); return "123 1 fixture"; });
  t.after(() => handlers.get("session_shutdown")());
  const call = () => tools.get("request_host_access").execute("host", { operation: "process_info", pid: 123, reason: "inspect process" }, undefined, undefined, f.ctx);
  await call(); assert.deepEqual(executions, [["/bin/ps", ["-p", "123", "-o", "pid=,ppid=,comm="]]]); assert.equal(f.prompts, 0);
  f.verdict = { decision: "deny", category: "out_of_scope" };
  await assert.rejects(call(), /out_of_scope/); assert.equal(executions.length, 1);
});

test("review diagnostics retain precise failure codes and masked request context without changing grants", async t => {
  const f = fixture(t); await f.activate("auto-deny Build the local demo");
  const cases = [
    ["provider_error", () => { throw new Error("HTTP 401 api_key=provider-secret-value"); }],
    ["incomplete_response", () => ({ stopReason: "error", errorMessage: "Account quota exhausted", content: [] })],
    ["unexpected_tool_call", () => ({ stopReason: "stop", content: [{ type: "toolCall", name: "bash" }] })],
    ["invalid_json", () => ({ stopReason: "stop", content: [{ type: "text", text: "not json" }] })],
    ["invalid_verdict", () => ({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"secrets"}' }] })],
    ["oversized_response", () => ({ stopReason: "stop", content: [{ type: "text", text: "x".repeat(4001) }] })],
  ];
  for (const [_code, run] of cases) { f.run = run; await assert.rejects(f.authorize(), /unavailable/); }
  f.ctx.modelRegistry.find = () => undefined;
  await assert.rejects(f.authorize(), /unavailable/);
  const results = f.query("audit_events").filter(row => row.kind === "review.result").map(row => JSON.parse(row.payload_json));
  assert.deepEqual(results.map(value => value.diagnostic.code), [...cases.map(([code]) => code), "model_unavailable"]);
  assert.match(results[0].diagnostic.error.message, /HTTP 401/);
  assert.equal(results[1].diagnostic.error.message, "Account quota exhausted");
  assert.doesNotMatch(JSON.stringify(f.query("audit_events")), /provider-secret-value/);
  assert.ok(f.query("permission_requests").every(row => row.status === "denied")); assert.equal(f.prompts, 0);
  assert.ok(f.query("audit_events").filter(row => row.kind === "review.request").every(row => row.request_id));
});
