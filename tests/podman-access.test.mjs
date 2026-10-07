import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPodmanAccess } from "../extensions/tool-policy/podman-access.ts";
import { registerApprovalReview } from "../lib/approval-review.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-podman-test-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), key = join(root, "key");
  mkdirSync(agent); mkdirSync(cwd); writeFileSync(key, "fixture", { mode: 0o600 });
  const saved = process.env.PI_PODMAN_BIN; process.env.PI_PODMAN_BIN = process.execPath;
  const tools = new Map(), handlers = new Map(), commands = new Map(), calls = [], reviews = [], updates = [];
  const connections = [{ Default: true, URI: "ssh://root@127.0.0.1:6000/run/podman/podman.sock", Identity: key }];
  let prompts = 0, active = true, result = "built\n", failure, onRun, verdict = "allow";
  const model = { provider: "fixture", id: "reviewer" };
  const ctx = { cwd, hasUI: true, model,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Build the local image" } }], getSessionId: () => "fixture", getSessionFile: () => undefined },
    modelRegistry: { find: () => model, streamSimple(_model, payload) { reviews.push(payload); return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision: verdict, category: verdict === "allow" ? "within_scope" : "out_of_scope" }) }] }) }; } },
    ui: { select: async (_title, choices) => { prompts++; assert.deepEqual(choices, APPROVAL_CHOICES.slice(0, 2)); return choices[1]; }, notify() {} },
  };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => active ? [...tools.keys()] : [] };
  registerApprovalReview(pi, agent, () => {});
  registerPodmanAccess(pi, agent, () => {}, async (program, args, options) => {
    calls.push({ program, args, options });
    if (args[0] === "system") return JSON.stringify(connections);
    if (onRun) await onRun(options);
    options.onStdout?.(Buffer.from(result)); options.onStderr?.(Buffer.from("stderr\n"));
    if (failure) throw failure;
    return "";
  });
  t.after(async () => { await handlers.get("session_shutdown")(); if (saved === undefined) delete process.env.PI_PODMAN_BIN; else process.env.PI_PODMAN_BIN = saved; rmSync(root, { recursive: true, force: true }); });
  return { root, agent, cwd, key, ctx, connections, handlers, commands, calls, reviews, updates,
    activate: () => commands.get("approvals").handler("auto-deny Build local images; do not push or delete volumes", ctx),
    run: (input = {}, signal) => tools.get("request_podman_access").execute("fixture", { args: ["version"], reason: "local verification", ...input }, signal, value => updates.push(value), ctx),
    disable() { active = false; }, get prompts() { return prompts; }, set result(value) { result = value; }, set failure(value) { failure = value; }, set onRun(value) { onRun = value; }, set verdict(value) { verdict = value; },
  };
}

test("generic build freezes argv, pins the local connection and clears inherited credentials", async t => {
  const f = fixture(t), args = ["build", "-t", "localhost/demo:local", "-f", "Containerfile", "."];
  await f.activate();
  const secret = process.env.PODMAN_TEST_CREDENTIAL; process.env.PODMAN_TEST_CREDENTIAL = "not-forwarded";
  t.after(() => { if (secret === undefined) delete process.env.PODMAN_TEST_CREDENTIAL; else process.env.PODMAN_TEST_CREDENTIAL = secret; });
  f.onRun = () => { args[2] = "other"; f.connections[0].URI = "ssh://root@127.0.0.1:9999/other"; };
  const result = await f.run({ args, timeout_seconds: 1800 });
  const call = f.calls[1];
  assert.deepEqual(call.args, ["--url", "ssh://root@127.0.0.1:6000/run/podman/podman.sock", "--ssh", "golang", "--identity", f.key, "build", "-t", "localhost/demo:local", "-f", "Containerfile", "."]);
  assert.equal(call.options.timeoutMs, 1800000); assert.equal(call.options.cwd, f.cwd);
  assert.equal(call.options.env.PODMAN_TEST_CREDENTIAL, undefined);
  assert.equal(call.options.env.CONTAINER_HOST, undefined);
  assert.equal(call.options.env.CONTAINERS_CONF, "/dev/null");
  assert.equal(f.prompts, 0); assert.match(f.reviews[0].messages[0].content, /localhost\/demo:local/);
  assert.match(result.content[0].text, /built\nstderr/); assert.ok(f.updates.length);
});

test("manual grants never persist and refusals require reset", async t => {
  const f = fixture(t);
  await f.run(); await f.run(); assert.equal(f.prompts, 2);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[0];
  await assert.rejects(f.run(), /not approved/);
  await assert.rejects(f.run(), /refused earlier/);
  assert.equal(f.calls.filter(call => call.args[0] === "--url").length, 2);
  await f.commands.get("podman-access").handler("reset", f.ctx);
  await f.activate(); await f.run();
});

test("unknown commands, host helpers, persistent flags and client file outputs fail before discovery", async t => {
  const f = fixture(t);
  for (const args of [["sh", "-c", "id"], ["machine", "ssh"], ["compose", "up"], ["system", "service"], ["system", "connection", "add"], ["image", "scp"], ["cp", "demo:/a", "/b"], ["kube", "generate", "--filename", "/b"], ["build", "--url=ssh://evil", "."], ["ps", "-cevil"], ["run", "--module", "evil", "image"], ["build", "--output=/b", "."], ["run", "--cidfile", "/b", "image"], ["--connection", "other", "ps"], ["build", "bad\narg"], []]) await assert.rejects(f.run({ args }));
  for (const timeout_seconds of [0, 1801, 1.5, "3"]) await assert.rejects(f.run({ timeout_seconds }));
  await assert.rejects(f.run({ reason: "" })); await assert.rejects(f.run({ unexpected: true }));
  await assert.rejects(f.run({ args: ["ps", "-acother"] }), /overrides/);
  assert.equal(f.calls.length, 0);
  await f.activate(); await f.run({ args: ["exec", "--", "demo", "sh", "-c", "echo hello"] });
});

test("parent-only capability is absent from child tools", async t => {
  const f = fixture(t); assert.equal(CONFINED_TOOLS.has("request_podman_access"), false);
  f.ctx.hasUI = false; await assert.rejects(f.run(), /interactive parent/); f.ctx.hasUI = true;
  const prior = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.run(), /interactive parent/); } finally { if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prior; }
  f.disable(); await assert.rejects(f.run(), /interactive parent/); assert.equal(f.calls.length, 0);
});

test("remote, ambiguous, credential-bearing and missing endpoints fail before approval", async t => {
  const f = fixture(t);
  for (const URI of ["ssh://root@remote.example/a", "tcp://127.0.0.1:1234/a", "ssh://root:secret@127.0.0.1/a", "unix:///a?x=y"]) {
    f.connections[0].URI = URI; await assert.rejects(f.run(), /endpoint/);
  }
  f.connections.push({ ...f.connections[0] }); await assert.rejects(f.run(), /exactly one/);
  f.connections.length = 0; await assert.rejects(f.run(), /exactly one/);
  assert.equal(f.prompts, 0); assert.ok(f.calls.every(call => call.args[0] === "system"));
});

test("review denial, expired consent and changed SSH key never dispatch", async t => {
  const f = fixture(t); await f.activate(); f.verdict = "deny";
  await assert.rejects(f.run(), /out_of_scope/);
  await f.commands.get("approvals").handler("manual", f.ctx);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  f.ctx.ui.select = async () => { now += 300001; return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.run(), /expired/);
  f.ctx.ui.select = async () => { writeFileSync(f.key, "changed-key"); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.run(), /identity changed/);
  assert.ok(f.calls.every(call => call.args[0] === "system"));
});

test("long automatic reviews bypass terminal sizing but manual prompts never hide their payload", async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ reason: "界".repeat(900) }), /does not fit/);
  await f.activate(); await f.run({ reason: "界".repeat(900) }); assert.equal(f.prompts, 0);
});

test("execution errors remain errors, output is bounded and terminal controls escaped", async t => {
  const f = fixture(t); await f.activate(); f.result = "x".repeat(70000) + "\u001b[31m";
  const result = await f.run(); assert.ok(result.content[0].text.length < 60100); assert.doesNotMatch(result.content[0].text, /\u001b/);
  f.failure = new Error("fixture nonzero exit");
  await assert.rejects(f.run(), /Podman failed.*\nfixture nonzero exit/);
});

test("session navigation cancels an ongoing build and no automatic retry occurs", async t => {
  const f = fixture(t); await f.activate(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.onRun = options => new Promise((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(new Error("fixture canceled")), { once: true }); entered(); });
  const pending = assert.rejects(f.run({ args: ["build", "."] }), /canceled/);
  await started; await f.handlers.get("session_before_switch")(); await pending;
  assert.equal(f.calls.length, 2);
});
