import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dunst from "../extensions/dunst/index.ts";
import mcp, { readServers } from "../extensions/mcp/index.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { McpConnection } from "../extensions/mcp/client.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { STRICT_TOOLS } from "../extensions/tool-policy/index.ts";

test("MCP accepts only trusted local stdio definitions, not project config, symlinks or remote URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  try {
    assert.deepEqual(readServers(agent, cwd), {});
    const path = join(agent, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { example: { command: "node", args: [] } } }));
    assert.deepEqual(readServers(agent, cwd), { example: { command: "node", args: [], network: true } });
    assert.equal(CONFINED_TOOLS.has("codemode"), false, "Codemode stays denied until its execution is confined");
    writeFileSync(path, JSON.stringify({ servers: { example: { command: "node", args: ["server.mjs"], network: false } } }));
    assert.equal(readServers(agent, cwd).example.command, "node");
    assert.throws(() => readServers(agent, root), /outside/);
    writeFileSync(path, JSON.stringify({ servers: { remote: { url: "https://example.com/mcp" } } }));
    assert.throws(() => readServers(agent, cwd), /local stdio/);
    rmSync(path); symlinkSync(join(cwd, "mcp.json"), path);
    assert.throws(() => readServers(agent, cwd));
    assert.equal(CONFINED_TOOLS.has("dunst"), false, "host automation never inherited by confined subagents");
    assert.equal(STRICT_TOOLS.has("dunst"), false, "host automation is also denied in the confined parent");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-approval-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(agent); mkdirSync(cwd); mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "dunst-mcp"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR, oldPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PATH = `${bin}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agent, cwd };
}

test("Dunst executes only the exact human-confirmed request; refusal, headless, abort and stale approvals never call the server", async t => {
  const { cwd } = fixture(t);
  const calls = [];
  t.mock.method(McpConnection.prototype, "call", async function (name, args) {
    calls.push({ name, args }); return { content: [{ type: "text", text: "fixture" }], details: undefined };
  });
  const handlers = new Map(); let tool;
  dunst({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand() {} });
  const ctx = { cwd, hasUI: true, ui: { select: async () => APPROVAL_CHOICES[0] } };
  const execute = (params, signal) => tool.execute("fixture", params, signal, undefined, ctx);
  await assert.rejects(execute({ tool: "click", args: { id: "button" } }), /not approved/);
  ctx.hasUI = false;
  await assert.rejects(execute({ tool: "help" }), /interactive/);
  ctx.hasUI = true;
  await assert.rejects(execute({ tool: "click" }, AbortSignal.abort()));
  const request = { tool: "type_into", args: { text: "approved" } };
  ctx.ui.select = async title => { assert.match(title, /approved/); request.args.text = "not approved"; return APPROVAL_CHOICES[1]; };
  await execute(request);
  assert.deepEqual(calls, [{ name: "type_into", args: { text: "approved" } }]);
  let decide, entered;
  const shown = new Promise(resolve => { entered = resolve; });
  ctx.ui.select = () => { entered(); return new Promise(resolve => { decide = resolve; }); };
  const pending = execute({ tool: "submit", args: { form: "payment" } });
  await shown;
  await handlers.get("session_before_switch")();
  decide(APPROVAL_CHOICES[1]);
  await assert.rejects(pending);
  assert.equal(calls.length, 1);
  await handlers.get("session_shutdown")();
});

test("Dunst observation consent avoids repeated prompts but never approves input, startup changes or server risk decisions", async t => {
  const { cwd, root } = fixture(t);
  const calls = [], handlers = new Map(), commands = new Map(); let tool, prompts = 0, confirmations = 0, allowActions = true;
  t.mock.method(McpConnection.prototype, "call", async function (name, args) {
    calls.push({ name, args }); return { content: [{ type: "text", text: "pending_approval" }], details: undefined };
  });
  dunst({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand: (name, command) => commands.set(name, command) });
  const ctx = { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      if (options.length === 4) { prompts++; return APPROVAL_CHOICES[2]; }
      confirmations++; return allowActions ? APPROVAL_CHOICES[1] : APPROVAL_CHOICES[0];
    }, notify() {},
  } };
  const execute = (name, args = {}) => tool.execute("fixture", { tool: name, args }, undefined, undefined, ctx);
  await execute("help"); await execute("list_windows"); await execute("attach", { window_id: 1 }); await execute("screenshot");
  assert.equal(prompts, 1);
  await execute("click_element", { id: "send" }); await execute("click_element", { id: "send" });
  await execute("type_into", { text: "message" }); await execute("launch_app", { app: "fixture" });
  assert.equal(confirmations, 4, "remembered observation never authorizes input or launch");
  assert.equal(calls.some(call => call.name === "approve"), false, "pending_approval never triggers an automatic server approval");
  allowActions = false;
  await assert.rejects(execute("approve", { id: "pending" }), /not approved/);
  await assert.rejects(execute("unknown_action"), /not approved/);
  assert.equal(calls.length, 8);
  ctx.hasUI = false;
  await assert.rejects(execute("page_state"), /interactive/);
  ctx.hasUI = true;
  const executable = join(root, "bin", "dunst-mcp");
  rmSync(executable); writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await execute("page_state"); assert.equal(prompts, 2, "changed executable needs fresh consent");
  await handlers.get("session_before_fork")();
  await execute("page_state"); assert.equal(prompts, 3);
  ctx.ui.select = async () => "Révoquer";
  await commands.get("dunst").handler("permissions", ctx);
  ctx.ui.select = async () => { prompts++; return APPROVAL_CHOICES[1]; };
  await execute("list_windows"); assert.equal(prompts, 4);
  await handlers.get("session_shutdown")();
});

test("MCP gates calls, not jailed discovery; read-only grants survive argument changes but configuration and sensitive calls need new approval", async t => {
  const { cwd, agent } = fixture(t);
  const path = join(agent, "mcp.json");
  const definition = { command: process.execPath, args: ["-e", "fixture"] };
  writeFileSync(path, JSON.stringify({ servers: { fixture: definition } }));
  const catalog = [
    { name: "read", annotations: { readOnlyHint: true } },
    { name: "send", annotations: { readOnlyHint: false } },
    { name: "contradictory", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "unknown" },
  ];
  const calls = [], handlers = new Map(), commands = new Map(); let tool, prompts = 0, confirmations = 0;
  t.mock.method(McpConnection.prototype, "start", async function () { if (!this.tools.length) this.tools.push(...structuredClone(catalog)); });
  t.mock.method(McpConnection.prototype, "call", async function (name, args) { calls.push({ name, args }); return { content: [{ type: "text", text: "fixture" }], details: undefined }; });
  mcp({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand: (name, command) => commands.set(name, command) });
  const ctx = { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      if (options.length === 4) { prompts++; return APPROVAL_CHOICES[2]; }
      confirmations++; return APPROVAL_CHOICES[1];
    }, confirm: async () => true, notify() {},
  } };
  const execute = (name, args = {}) => tool.execute("fixture", { server: "fixture", tool: name, args }, undefined, undefined, ctx);
  await execute("help"); assert.equal(prompts, 0);
  await execute("read", { query: "one" }); await execute("read", { query: "two" });
  assert.equal(prompts, 1);
  await execute("send"); await execute("send"); await execute("contradictory"); await execute("unknown");
  assert.equal(confirmations, 4);
  const request = { text: "approved" };
  ctx.ui.select = async (body, options) => {
    if (options.length === 4) { prompts++; return APPROVAL_CHOICES[2]; }
    assert.match(body, /approved/); request.text = "changed"; return APPROVAL_CHOICES[1];
  };
  await execute("send", request);
  assert.deepEqual(calls.at(-1), { name: "send", args: { text: "approved" } });
  definition.env = { FIXTURE: "changed" };
  writeFileSync(path, JSON.stringify({ servers: { fixture: definition } }));
  await execute("read"); assert.equal(prompts, 2);
  ctx.ui.confirm = async () => true;
  await commands.get("mcp").handler("permissions fixture", ctx);
  await execute("read"); assert.equal(prompts, 3);
  await handlers.get("session_before_tree")();
  ctx.ui.select = async () => {
    definition.env.FIXTURE = "changed during consent";
    writeFileSync(path, JSON.stringify({ servers: { fixture: definition } }));
    return APPROVAL_CHOICES[3];
  };
  const before = calls.length;
  await assert.rejects(execute("read"), /configuration changed/);
  assert.equal(calls.length, before);
  ctx.hasUI = false;
  await assert.rejects(execute("read"), /human approval/);
  ctx.hasUI = true;
  writeFileSync(path, "invalid config");
  await commands.get("mcp").handler("permissions fixture", ctx);
  writeFileSync(path, JSON.stringify({ servers: {} }));
  await commands.get("mcp").handler("permissions", ctx);
  await handlers.get("session_shutdown")();
});
