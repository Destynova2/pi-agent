import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSource, httpInspection, projectHttpJson } from "../lib/http-inspection.ts";
import { registerHttpAccess } from "../extensions/tool-policy/http-access.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-http-access-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), file = join(root, "config.env");
  mkdirSync(agent); mkdirSync(cwd); writeFileSync(file, "PASSWORD=fixture-private-password\n");
  const tools = new Map(), handlers = new Map(), commands = new Map(), calls = [], dialogs = [];
  let active = true, beforeApprove = () => {}, inspect = async (request, source, signal, revalidate) => {
    revalidate(); calls.push({ request, source, signal }); return { status: 200, body: "withheld" };
  };
  const ctx = { cwd, hasUI: true, ui: {
    async select(title, choices) {
      dialogs.push(title); beforeApprove();
      return choices.includes("Lire la page suivante") ? "Lire la page suivante" : APPROVAL_CHOICES[1];
    }, notify() {},
  } };
  registerHttpAccess({
    registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active ? [...tools.keys()] : [],
  }, agent, () => {}, (...args) => inspect(...args));
  t.after(async () => { await handlers.get("session_shutdown")(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, agent, cwd, file, ctx, calls, dialogs, handlers, commands, tools,
    request: (value = {}, signal) => tools.get("request_http_access").execute("probe", {
      url: "http://127.0.0.1:8081/service/rest/v1/security/users", reason: "Check the requested local service", ...value,
    }, signal, undefined, ctx),
    set beforeApprove(value) { beforeApprove = value; }, set inspect(value) { inspect = value; },
    disable() { active = false; },
  };
}

test("HTTP inspection accepts exact GET metadata requests and refuses secret-bearing or broad inputs", () => {
  const request = { url: "https://api.example.com/nexus/service/rest/v1/repositories", reason: "Inspect repositories", fields: ["name", "attributes.proxy.remoteUrl"] };
  assert.deepEqual(httpInspection(request), request);
  for (const value of [
    { url: "file:///etc/passwd" }, { url: "http://api.example.com/" }, { url: "http://127.0.0.2/" },
    { url: "https://user:password@example.com/" }, { url: "https://example.com/?token=secret" },
    { url: "https://example.com/#fragment" }, { method: "POST" }, { headers: { authorization: "secret" } },
    { url: "https://blocked.example.com./" },
    { fields: ["password"] }, { fields: ["attributes.secret"] }, { fields: ["__proto__.name"] },
    { fields: ["constructor.name"] }, { fields: [] }, { auth: { kind: "basic", file: "/project/.env", key: "PASSWORD" } },
    { auth: { kind: "bearer", file: "/project/.env", key: "TOKEN", username: "admin" } },
  ]) assert.throws(() => httpInspection({ ...request, ...value }));
});

test("credential references bind exact files including outside cwd; aliases, protected paths and changed sources fail", t => {
  const f = fixture(t), request = httpInspection({ url: "http://localhost:8081/", reason: "Check", auth: { kind: "basic", file: f.file, key: "PASSWORD", username: "admin" } });
  const source = credentialSource(request, f.agent);
  assert.equal(source.read(), "fixture-private-password");
  writeFileSync(f.file, "PASSWORD=changed\n");
  assert.throws(() => source.read(), /changed/);
  const link = join(f.cwd, "link.env"); symlinkSync(f.file, link);
  assert.throws(() => credentialSource({ ...request, auth: { ...request.auth, file: link } }, f.agent), /exact dotenv/);
  const privateFile = join(f.agent, "private.env"); writeFileSync(privateFile, "PASSWORD=private\n");
  assert.throws(() => credentialSource({ ...request, auth: { ...request.auth, file: privateFile } }, f.agent), /protected/);
  assert.throws(() => credentialSource({ ...request, auth: { ...request.auth, file: "../config.env" } }, f.agent));
});

test("selected JSON omits nested data, masks referenced credentials and removes URL credentials", () => {
  const secret = "fixture-secret-value", encoded = Buffer.from(`admin:${secret}`).toString("base64");
  const result = projectHttpJson(JSON.stringify([{ name: `${secret} ${encoded}`, format: "docker",
    attributes: { proxy: { remoteUrl: "https://user:private@quay.io/path?token=hidden" }, password: "unselected-private" },
    raw: { confidential: "unselected-private" } }]), ["name", "format", "attributes.proxy.remoteUrl", "raw"], [secret, `admin:${secret}`]);
  assert.equal(result[0].format, "docker"); assert.equal(result[0].raw, null);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|YWRtaW46|unselected-private|user:private|token=hidden/);
  assert.equal(projectHttpJson('{"value":12345}', ["value"], ["12345"])[0].value, "[REDACTED]");
  assert.throws(() => projectHttpJson('"raw private response"', ["name"], []));
});

test("HTTP access freezes the request, keeps credential values out of approval/results and never grants subagents", async t => {
  const f = fixture(t);
  assert.equal(CONFINED_TOOLS.has("request_http_access"), false);
  const auth = { kind: "basic", file: f.file, key: "PASSWORD", username: "admin" };
  f.beforeApprove = () => { auth.key = "DIFFERENT"; };
  const result = await f.request({ auth });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.auth.key, "PASSWORD");
  assert.equal(f.calls[0].source.read(), "fixture-private-password");
  assert.doesNotMatch(JSON.stringify([f.dialogs, result]), /fixture-private-password/);
  assert.equal(f.calls[0].signal.aborted, false);
  f.ctx.hasUI = false; await assert.rejects(f.request(), /parent/);
  f.ctx.hasUI = true;
  const old = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.request(), /parent/); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = old; }
  f.disable(); await assert.rejects(f.request(), /parent/);
  assert.equal(f.calls.length, 1);
});

test("refusal, policy changes and credential edits stop dispatch without a broader fallback", async t => {
  const f = fixture(t);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[0];
  await assert.rejects(f.request(), /not approved/);
  f.ctx.ui.select = async (_title, choices) => choices.includes("Lire la page suivante") ? "Lire la page suivante" : APPROVAL_CHOICES[1];
  await assert.rejects(f.request(), /refused earlier/);
  await f.commands.get("http-access").handler("reset", f.ctx);
  writeFileSync(join(f.agent, "network-policy.json"), JSON.stringify({ allow: [], deny: ["blocked.example.com"] }));
  await assert.rejects(f.request({ url: "https://blocked.example.com/" }), /denied/);
  await assert.rejects(f.request({ url: "https://blocked.example.com./" }), /terminal DNS dot/);
  f.ctx.ui.select = async () => { writeFileSync(f.file, "PASSWORD=changed\n"); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request({ auth: { kind: "basic", username: "admin", file: f.file, key: "PASSWORD" } }), /changed/);
  f.ctx.ui.select = async () => { writeFileSync(join(f.agent, "network-policy.json"), '{"allow":[],"deny":["new.example.com"]}'); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request(), /policy changed/);
  assert.equal(f.calls.length, 0);
});

test("navigation cancels pending approval and transport errors never reveal secret-bearing messages", async t => {
  const f = fixture(t);
  let answer, shown;
  const entered = new Promise(resolve => { shown = resolve; });
  f.ctx.ui.select = () => { shown(); return new Promise(resolve => { answer = resolve; }); };
  const rejected = assert.rejects(f.request(), /abort|cancel|stale/i);
  await entered;
  const closed = f.handlers.get("session_before_switch")(); answer(APPROVAL_CHOICES[1]);
  await rejected; await closed;
  assert.equal(f.calls.length, 0);
  f.ctx.ui.select = async (_title, choices) => choices.includes("Lire la page suivante") ? "Lire la page suivante" : APPROVAL_CHOICES[1];
  f.inspect = async () => { throw Object.assign(new Error("request included private-secret-value"), { code: "ECONNREFUSED" }); };
  await assert.rejects(f.request(), error => /ECONNREFUSED/.test(error.message) && !/private-secret/.test(error.message));
});
