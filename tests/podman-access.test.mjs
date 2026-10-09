import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PODMAN_PROJECT_CHOICE, registerPodmanAccess } from "../extensions/tool-policy/podman-access.ts";
import { registerApprovalReview } from "../lib/approval-review.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";

function largeTerminal(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: 100, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor); else delete process.stdout.rows; });
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-podman-test-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), key = join(root, "key");
  mkdirSync(agent); mkdirSync(cwd); writeFileSync(key, "fixture", { mode: 0o600 });
  const saved = process.env.PI_PODMAN_BIN; process.env.PI_PODMAN_BIN = process.execPath;
  const tools = new Map(), handlers = new Map(), commands = new Map(), calls = [], reviews = [], updates = [], promptPayloads = [];
  const connections = [{ Default: true, URI: "ssh://root@127.0.0.1:6000/run/podman/podman.sock", Identity: key }];
  let prompts = 0, active = true, result = "built\n", failure, onRun, onCommand, verdict = "allow", choice = APPROVAL_CHOICES[1];
  const model = { provider: "fixture", id: "reviewer" };
  const ctx = { cwd, hasUI: true, model,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Build the local image" } }], getSessionId: () => "fixture", getSessionFile: () => undefined },
    modelRegistry: { find: () => model, streamSimple(_model, payload) { reviews.push(payload); return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision: verdict, category: verdict === "allow" ? "within_scope" : "out_of_scope" }) }] }) }; } },
    ui: { select: async (title, choices) => { prompts++; promptPayloads.push({ title, choices }); assert.deepEqual(choices, choices.length === 3 ? [...APPROVAL_CHOICES.slice(0, 2), PODMAN_PROJECT_CHOICE] : APPROVAL_CHOICES.slice(0, 2)); return choice; }, notify() {} },
  };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => active ? [...tools.keys()] : [] };
  registerApprovalReview(pi, agent, () => {});
  registerPodmanAccess(pi, agent, () => {}, async (program, args, options) => {
    calls.push({ program, args, options });
    if (args[0] === "system") return JSON.stringify(connections);
    if (onCommand) return onCommand(args.slice(6), options);
    if (onRun) await onRun(options);
    options.onStdout?.(Buffer.from(result)); options.onStderr?.(Buffer.from("stderr\n"));
    if (failure) throw failure;
    return "";
  });
  t.after(async () => { await handlers.get("session_shutdown")(); if (saved === undefined) delete process.env.PI_PODMAN_BIN; else process.env.PI_PODMAN_BIN = saved; rmSync(root, { recursive: true, force: true }); });
  return { root, agent, cwd, key, ctx, connections, handlers, commands, calls, reviews, updates, promptPayloads,
    activate: () => commands.get("approvals").handler("auto-deny Build local images; do not push or delete volumes", ctx),
    run: (input = {}, signal) => tools.get("request_podman_access").execute("fixture", { args: ["version"], reason: "local verification", ...input }, signal, value => updates.push(value), ctx),
    disable() { active = false; }, get prompts() { return prompts; }, set choice(value) { choice = value; }, set result(value) { result = value; }, set failure(value) { failure = value; }, set onRun(value) { onRun = value; }, set onCommand(value) { onCommand = value; }, set verdict(value) { verdict = value; },
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

test("manual once grants never become permanent and refusals require reset", async t => {
  largeTerminal(t);
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

const sourceId = "a".repeat(64), candidateId = "b".repeat(64);
const createRequest = { args: ["create", "--pull=never", "--name", "candidate", "localhost/demo:local"], env_from_container: sourceId };

test("private create transfers exact environment by stdin and verifies equality without exposing values", async t => {
  const f = fixture(t); await f.activate();
  const secret = "private-env-value-123", environment = ["EMPTY=", `TOKEN=${secret}=with spaces`, "OTHER=#literal", `TOKEN=${secret}=with spaces`];
  f.onCommand = (args, options) => {
    assert.equal(options.onStdout, undefined); assert.equal(options.onStderr, undefined);
    if (args[0] === "container") {
      assert.deepEqual(args.slice(0, -1), ["container", "inspect", "--format", "{{json .Config.Env}}"]);
      assert.ok([sourceId, candidateId].includes(args.at(-1)));
      assert.equal(options.input, undefined);
      return JSON.stringify(args.at(-1) === sourceId ? environment : [...new Set(environment)].reverse());
    }
    assert.deepEqual(args, ["create", "--unsetenv-all", "--env-file", "/dev/stdin", "--http-proxy=false", ...createRequest.args.slice(1)]);
    assert.equal(options.input, [...new Set(environment)].sort().join("\n") + "\n");
    return candidateId + "\n";
  };
  const result = await f.run(createRequest);
  assert.equal(result.details.environmentPreserved, true); assert.equal(result.details.containerId, candidateId);
  assert.equal(f.calls.length, 4); assert.equal(f.prompts, 0); assert.equal(f.reviews.length, 1);
  assert.match(f.reviews[0].messages[0].content, /Config.Env/);
  assert.equal(f.updates.length, 0);
  assert.equal(JSON.stringify([result, f.reviews, f.calls.map(call => call.args)]).includes(secret), false);
  for (const name of readdirSync(join(f.agent, "permission-audit"))) assert.equal(readFileSync(join(f.agent, "permission-audit", name)).includes(Buffer.from(secret)), false);
  assert.deepEqual(readdirSync(f.cwd), []);
});

test("private environment transfer rejects ambiguous sources and overrides before any process", async t => {
  const f = fixture(t);
  for (const env_from_container of ["demo", "abc123", "a".repeat(63), "A".repeat(64), null, 1]) await assert.rejects(f.run({ ...createRequest, env_from_container }), /full container ID/);
  for (const args of [["run", "image"], ["exec", "demo", "env"], ["container", "clone", sourceId]]) await assert.rejects(f.run({ ...createRequest, args }), /requires create/);
  for (const flag of ["-eTOKEN=value", "-ie", "--env", "--env-file=/a", "--env-merge", "--env-host", "--unsetenv=TOKEN", "--unsetenv-all=false", "--secret", "--http-proxy=true"]) await assert.rejects(f.run({ ...createRequest, args: ["create", flag, "image"] }), /overrides/);
  assert.equal(f.calls.length, 0);
});

test("private transfer refuses malformed or multiline environment before create", async t => {
  for (const value of ["not json", "null", "{}", JSON.stringify(["NO_EQUALS"]), JSON.stringify(["=value"]), JSON.stringify(["A=one", "A=two"]), JSON.stringify(["TOKEN=one\ntwo"]), JSON.stringify(["TOKEN=one\rtwo"]), JSON.stringify(["TOKEN=one\0two"])]) {
    const f = fixture(t); await f.activate(); f.onCommand = () => value;
    await assert.rejects(f.run(createRequest), /source environment read.*output suppressed/);
    assert.equal(f.calls.length, 2); assert.equal(f.updates.length, 0);
  }
});

test("private transfer suppresses secrets in failures and detects incomplete or altered results", async t => {
  for (const failure of ["read", "create", "verify", "mismatch", "bad-id"]) {
    const f = fixture(t); await f.activate(); const secret = "never-display-this-secret";
    f.onCommand = (args, options) => {
      const phase = args[0] !== "container" ? "create" : args.at(-1) === sourceId ? "read" : "verify";
      assert.equal(options.onStdout, undefined); assert.equal(options.onStderr, undefined);
      if (failure === phase) throw new Error(secret);
      if (phase === "create") return failure === "bad-id" ? secret : candidateId;
      return JSON.stringify([`TOKEN=${failure === "mismatch" && phase === "verify" ? "changed" : secret}`]);
    };
    await assert.rejects(f.run(createRequest), error => !error.message.includes(secret) && /secret-bearing output suppressed/.test(error.message) && !error.cause);
    assert.ok(f.calls.length <= 4); assert.equal(f.updates.length, 0);
  }
});

test("denial never reads secrets; revoked approval or cancellation after read never creates", async t => {
  const denied = fixture(t); await denied.activate(); denied.verdict = "deny";
  await assert.rejects(denied.run(createRequest), /out_of_scope/); assert.equal(denied.calls.length, 1);
  for (const cancel of [false, true]) {
    const f = fixture(t); await f.activate(); const controller = new AbortController();
    f.onCommand = () => { if (cancel) controller.abort(); else f.disable(); return '["TOKEN=private"]'; };
    await assert.rejects(f.run(createRequest, controller.signal), /create failed or was canceled/);
    assert.equal(f.calls.length, 2);
  }
});

test("container create supports empty environments and one deadline for all private phases", async t => {
  const f = fixture(t); await f.activate(); let now = Date.now(), step = 0;
  t.mock.method(Date, "now", () => now);
  f.onCommand = (args, options) => {
    assert.equal(options.timeoutMs, 3000 - step++ * 1000); now += 1000;
    if (args[1] === "create") {
      assert.deepEqual(args.slice(0, 6), ["container", "create", "--unsetenv-all", "--env-file", "/dev/stdin", "--http-proxy=false"]);
      assert.equal(options.input, ""); return candidateId;
    }
    return "[]";
  };
  const result = await f.run({ ...createRequest, args: ["container", ...createRequest.args], timeout_seconds: 3 });
  assert.equal(result.details.environmentPreserved, true);
});

test("second Podman request can grant the whole engine for this project without further prompts or reviews", async t => {
  largeTerminal(t); const f = fixture(t);
  await f.run({ args: ["version"] });
  assert.equal(f.promptPayloads[0].choices.length, 2);
  f.choice = PODMAN_PROJECT_CHOICE;
  await f.run({ args: ["build", "."] });
  assert.equal(f.promptPayloads[1].choices.length, 3);
  assert.match(f.promptPayloads[1].title, /suppressions de conteneurs\/volumes, publications/);
  await f.handlers.get("session_start")();
  await f.activate(); f.verdict = "deny";
  // Disposable executor only: broad consent includes different mutating operations.
  await f.run({ args: ["volume", "rm", "fixture-volume"] });
  await f.run({ args: ["push", "localhost/demo:local", "registry.example/demo:local"] });
  assert.equal(f.prompts, 2); assert.equal(f.reviews.length, 0);
  assert.equal(f.calls.filter(call => call.args[0] === "--url").length, 4);
  await assert.rejects(f.run({ args: ["machine", "ssh"] }), /Unsupported/);
  f.ctx.hasUI = false; await assert.rejects(f.run(), /out_of_scope/);
  assert.equal(f.reviews.length, 1, "headless use reviews the exact action even with broad saved consent");
  assert.equal(f.calls.filter(call => call.args[0] === "--url").length, 4);
});

test("project engine access does not follow another project, endpoint or replaced identity", async t => {
  largeTerminal(t); const f = fixture(t);
  await f.run(); f.choice = PODMAN_PROJECT_CHOICE; await f.run();
  f.choice = APPROVAL_CHOICES[1];
  const other = join(f.root, "other"); mkdirSync(other); f.ctx.cwd = other;
  await f.run(); assert.equal(f.promptPayloads.at(-1).choices.length, 2);
  f.ctx.cwd = f.cwd; f.connections[0].URI = "ssh://root@127.0.0.1:6001/run/podman/podman.sock";
  await f.run(); assert.equal(f.promptPayloads.at(-1).choices.length, 2);
  f.connections[0].URI = "ssh://root@127.0.0.1:6000/run/podman/podman.sock";
  writeFileSync(f.key, "changed identity");
  await f.run(); assert.equal(f.promptPayloads.at(-1).choices.length, 2);
  assert.equal(f.prompts, 5);
});

test("reset keeps explicit project access; permissions revokes it and resets the repeat offer", async t => {
  largeTerminal(t); const f = fixture(t);
  await f.run(); f.choice = PODMAN_PROJECT_CHOICE; await f.run();
  await f.commands.get("podman-access").handler("reset", f.ctx);
  await f.run({ args: ["ps"] }); assert.equal(f.prompts, 2);
  await f.commands.get("podman-access").handler("permissions", f.ctx);
  f.choice = APPROVAL_CHOICES[1]; await f.run();
  assert.equal(f.prompts, 3); assert.equal(f.promptPayloads.at(-1).choices.length, 2);
  f.ctx.hasUI = false;
  await assert.rejects(f.commands.get("podman-access").handler("permissions", f.ctx), /interactive parent/);
});

test("automatic successes never create repeated-access offers or project engine grants", async t => {
  largeTerminal(t); const f = fixture(t); await f.activate();
  f.ctx.hasUI = false;
  await f.run(); await f.run({ args: ["ps"] });
  assert.equal(f.prompts, 0); assert.equal(f.reviews.length, 2);
  assert.equal(readdirSync(f.agent).includes("mcp-approvals"), false);
  f.ctx.hasUI = true;
  await f.commands.get("approvals").handler("manual", f.ctx);
  await f.run(); assert.equal(f.promptPayloads[0].choices.length, 2);
});

test("revoking a saved engine grant between secret read and creation prevents dispatch", async t => {
  largeTerminal(t); const f = fixture(t);
  await f.run(); f.choice = PODMAN_PROJECT_CHOICE; await f.run();
  f.onCommand = () => { new McpApprovals(f.agent).revoke(f.cwd, "podman-access"); return '["TOKEN=private"]'; };
  await assert.rejects(f.run(createRequest), /create failed or was canceled/);
  assert.equal(f.calls.length, 6, "only discovery and source inspection after two granted calls");
  assert.equal(f.prompts, 2);
});
