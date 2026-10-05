import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHostAccess, publicContainer } from "../extensions/tool-policy/host-access.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-access-")));
  const agent = join(root, "agent"), cwd = join(root, "project"); mkdirSync(agent); mkdirSync(cwd);
  const old = process.env.PI_PODMAN_BIN; process.env.PI_PODMAN_BIN = process.execPath;
  const handlers = new Map(), tools = new Map(), commands = new Map(), calls = [];
  let prompts = 0, verifyCalls = 0, result = JSON.stringify({ id: "a".repeat(64), name: "service", ports: "127.0.0.1:9091->9091/tcp", status: "running" }), failure, active = true;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { prompts++; assert.deepEqual(choices, APPROVAL_CHOICES.slice(0, 2)); return choices[1]; }, notify() {} } };
  registerHostAccess({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => active ? [...tools.keys()] : [] }, agent, () => { verifyCalls++; }, async (program, args, options) => { calls.push({ program, args, options }); if (failure) throw failure; return result; });
  t.after(async () => { await handlers.get("session_shutdown")(); if (old === undefined) delete process.env.PI_PODMAN_BIN; else process.env.PI_PODMAN_BIN = old; rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, ctx, calls, handlers, commands, tools, request: (input, signal) => tools.get("request_host_access").execute("test", { reason: "inspect local service", ...input }, signal, undefined, ctx), set result(value) { result = value; }, set failure(value) { failure = value; }, disable() { active = false; }, get prompts() { return prompts; }, get verified() { return verifyCalls; } };
}

test("host access is parent-only, default-deny, once-only and never inherited by subagents", async t => {
  const f = fixture(t);
  assert.equal(CONFINED_TOOLS.has("request_host_access"), false);
  for (const answer of [undefined, APPROVAL_CHOICES[0], APPROVAL_CHOICES[2], APPROVAL_CHOICES[3]]) {
    f.ctx.ui.select = async () => answer;
    await assert.rejects(f.request({ operation: "podman_list" }), /not approved|refused/);
    await f.commands.get("host-access").handler("reset", f.ctx);
  }
  f.ctx.hasUI = false;
  await assert.rejects(f.request({ operation: "podman_list" }), /interactive parent/);
  f.ctx.hasUI = true;
  const old = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.request({ operation: "podman_list" }), /interactive parent/); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = old; }
  f.disable(); await assert.rejects(f.request({ operation: "podman_list" }), /interactive parent/);
  assert.equal(f.calls.length, 0);
});

test("exact frozen arguments execute without a shell and every call asks again", async t => {
  const f = fixture(t), args = ["restart", "service"];
  f.ctx.ui.select = async title => { assert.match(title, /HORS SANDBOX/); assert.match(title, /restart/); args[1] = "different"; return APPROVAL_CHOICES[1]; };
  const result = await f.request({ operation: "podman_command", args });
  assert.deepEqual(f.calls[0].args, ["restart", "service"]);
  assert.equal(f.calls[0].options.timeoutMs, 60_000);
  assert.equal(f.calls[0].options.maxBytes, 1024 * 1024);
  assert.equal(f.calls[0].options.onStdout, undefined);
  assert.match(result.content[0].text, /Verify the requested effect separately/);
  assert.doesNotMatch(JSON.stringify(result), /fixture/);
  let prompts = 0; f.ctx.ui.select = async () => { prompts++; return APPROVAL_CHOICES[1]; };
  await f.request({ operation: "podman_list" }); await f.request({ operation: "podman_list" });
  assert.equal(prompts, 2); assert.ok(f.verified > 0);
});

test("unknown operations, flags, traversal, missing fields and oversized requests are refused", async t => {
  const f = fixture(t);
  for (const input of [
    { operation: "shell", args: ["sh"] }, { operation: "podman_list", target: "unused" },
    { operation: "podman_inspect" }, { operation: "podman_inspect", target: "--latest" },
    { operation: "podman_command", args: ["compose", "up"] },
    { operation: "podman_command", args: ["restart", "--all"] },
    { operation: "podman_command", args: ["restart", "service", "--module=evil"] },
    { operation: "podman_command", args: ["machine", "ssh"] },
    { operation: "podman_logs", target: "--latest" }, { operation: "podman_logs", target: "service", tail: 501 },
    { operation: "podman_logs", target: "service", tail: 0 }, { operation: "podman_logs", target: "service", args: ["--follow"] },
    { operation: "podman_list", tail: 5 }, { operation: "podman_machine_list", target: "unused" },
    { operation: "podman_command", args: ["kube", "play", "https://example.com/manifest"] },
    { operation: "process_info", pid: -1 }, { operation: "podman_list", reason: "x".repeat(2001) },
  ]) await assert.rejects(f.request(input));
  assert.equal(f.calls.length, 0); assert.equal(f.prompts, 0);
});

test("bounded Podman logs include stderr, escape terminal controls and never follow", async t => {
  const f = fixture(t);
  // Simulate Podman's separate stdout/stderr callbacks, both used for container logs.
  f.ctx.ui.select = async title => { assert.match(title, /secrets applicatifs possibles/); return APPROVAL_CHOICES[1]; };
  await f.request({ operation: "podman_logs", target: "service", tail: 25 });
  const call = f.calls.at(-1);
  assert.deepEqual(call.args, ["logs", "--tail", "25", "--since", "1h", "--timestamps", "--", "service"]);
  assert.equal(typeof call.options.onStdout, "function");
  assert.equal(typeof call.options.onStderr, "function");
  assert.equal(call.options.timeoutMs, 60000);
  await f.request({ operation: "podman_logs", target: "service" });
  assert.equal(f.calls.at(-1).args[2], "100");
});

test("machine diagnostics project only validated fields and omit identity/connection details", async t => {
  const f = fixture(t);
  f.result = JSON.stringify([{ Name: "local", Running: true, CPUs: 12, Memory: "25769803776", IdentityPath: "private-key-path", Secret: "secret-value" }]);
  const result = await f.request({ operation: "podman_machine_list" });
  assert.deepEqual(f.calls[0].args, ["machine", "list", "--format", "json"]);
  assert.deepEqual(JSON.parse(result.content[0].text), [{ name: "local", running: true, cpus: 12, memory: 25769803776 }]);
  assert.doesNotMatch(JSON.stringify(result), /private-key-path|secret-value/);
});

test("oversized native approval dialogs fail before prompting rather than hiding choices or truncating arguments", async t => {
  const f = fixture(t);
  await assert.rejects(f.request({ operation: "podman_list", reason: "界".repeat(450) }), /does not fit the terminal/);
  assert.equal(f.prompts, 0); assert.equal(f.calls.length, 0);
});

test("abort, expired consent, changed executable and navigation prevent dispatch", async t => {
  const f = fixture(t);
  await assert.rejects(f.request({ operation: "podman_list" }, AbortSignal.abort()));
  let answer, shown;
  const entered = new Promise(resolve => { shown = resolve; });
  f.ctx.ui.select = () => { shown(); return new Promise(resolve => { answer = resolve; }); };
  const pending = assert.rejects(f.request({ operation: "podman_list" }), /abort|stale|cancel/i);
  await entered;
  const closing = f.handlers.get("session_before_switch")(); answer(APPROVAL_CHOICES[1]);
  await closing; await pending; assert.equal(f.calls.length, 0);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  f.ctx.ui.select = async () => { now += 300001; return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request({ operation: "podman_list" }), /expired/);
  const executable = join(f.root, "podman"); writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); process.env.PI_PODMAN_BIN = executable;
  f.ctx.ui.select = async () => { writeFileSync(executable, "#!/bin/sh\nexit 1\n"); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request({ operation: "podman_list" }), /changed/);
  assert.equal(f.calls.length, 0);
});

test("inspect returns public origins and environment names, never private values, labels, args or health data", async t => {
  const f = fixture(t);
  const container = { Id: "a".repeat(64), Name: "service", State: { Status: "running", Error: "secret-health" }, Config: { Env: ["APP_PASSWORD=secret-password", "APP_PUBLIC_URL=https://user:secret-url@example.com/private?token=secret-query", "APP_LOCAL_PASSWORD_FALLBACK=true"], Cmd: ["secret-argument"], Labels: { secret: "secret-label" } }, NetworkSettings: { Ports: { "9091/tcp": [{ HostIp: "127.0.0.1", HostPort: "9091" }] } } };
  f.result = JSON.stringify([container]);
  const result = await f.request({ operation: "podman_inspect", target: "service" });
  const text = JSON.stringify(result); assert.doesNotMatch(text, /secret-|private|token=/);
  assert.match(text, /APP_PASSWORD/); assert.match(text, /https:\/\/example.com/);
  assert.deepEqual(publicContainer(container).ports, { "9091/tcp": [{ host: "127.0.0.1", port: 9091 }] });
  container.Id = { password: "secret-object" }; container.State.Status = { secret: "secret-status" };
  assert.doesNotMatch(JSON.stringify(publicContainer(container)), /secret-/);
  assert.throws(() => publicContainer({ Config: { Env: ["MALFORMED_PRIVATE_VALUE"] } }), /Invalid container environment/);
  f.failure = new Error("secret-error-stderr");
  await assert.rejects(f.request({ operation: "podman_list" }), error => !error.message.includes("secret-") && /output withheld/.test(error.message));
});

test("clipboard transfer keeps secret values out of UI, argv and results; changed/outside sources fail", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), file = join(f.cwd, ".env"), key = "APP_PASSWORD";
  writeFileSync(file, `${key}='secret clipboard value'\n`);
  f.ctx.ui.select = async title => { assert.doesNotMatch(title, /secret clipboard value/); return APPROVAL_CHOICES[1]; };
  const result = await f.request({ operation: "clipboard_env", file, key });
  assert.equal(f.calls[0].program, "/usr/bin/pbcopy"); assert.deepEqual(f.calls[0].args, []);
  assert.equal(f.calls[0].options.input, "secret clipboard value");
  assert.doesNotMatch(JSON.stringify(result), /secret clipboard value/);
  f.ctx.ui.select = async () => { writeFileSync(file, `${key}=changed\n`); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request({ operation: "clipboard_env", file, key }), /changed/);
  const outside = join(f.root, "outside"); writeFileSync(outside, `${key}=outside\n`); symlinkSync(outside, join(f.cwd, "link"));
  await assert.rejects(f.request({ operation: "clipboard_env", file: "link", key }), /inside/);
  assert.equal(f.calls.length, 1);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[1];
  f.result = JSON.stringify([{ Config: { Env: [`${key}=container-secret`] } }]);
  const copied = await f.request({ operation: "clipboard_container_env", target: "service", key });
  assert.equal(f.calls.at(-1).program, "/usr/bin/pbcopy"); assert.equal(f.calls.at(-1).options.input, "container-secret");
  assert.doesNotMatch(JSON.stringify(copied), /container-secret/);
});

test("Podman manifest identity is rechecked and process queries exclude argv/environment", async t => {
  const f = fixture(t), file = join(f.cwd, "service.yaml"); writeFileSync(file, "apiVersion: v1\n");
  f.ctx.ui.select = async () => { writeFileSync(file, "changed\n"); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request({ operation: "podman_command", args: ["kube", "play", "--replace", file] }), /manifest changed/);
  assert.equal(f.calls.length, 0);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[1];
  await f.request({ operation: "process_info", pid: 123 });
  assert.deepEqual(f.calls[0].args, ["-p", "123", "-o", "pid=,ppid=,comm="]);
});

test("model catalog uses only registry snapshots and exposes no credentials or headers", async t => {
  const f = fixture(t), model = { provider: "fixture", id: "one", name: "One", contextWindow: 100, maxTokens: 20, apiKey: "secret-token", headers: { Authorization: "secret-header" } };
  let reads = 0;
  f.ctx.modelRegistry = { getAll() { reads++; return [model]; }, getAvailable() { reads++; return [model]; }, refresh() { throw new Error("Must not refresh"); }, getApiKey() { throw new Error("Must not resolve auth"); } };
  const result = await f.tools.get("model_catalog").execute("catalog", {}, undefined, undefined, f.ctx);
  assert.equal(reads, 2); assert.equal(f.calls.length, 0); assert.equal(f.prompts, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret-|Authorization/);
  assert.match(result.content[0].text, /cached, not remotely verified/);
});
