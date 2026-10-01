import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dunst from "../extensions/dunst/index.ts";
import { readServers } from "../extensions/mcp/index.ts";
import { McpConnection } from "../extensions/mcp/client.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

test("MCP accepts only trusted local stdio definitions, not project config, symlinks or remote URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  try {
    assert.deepEqual(readServers(agent, cwd), {});
    const path = join(agent, "mcp.json");
    writeFileSync(path, JSON.stringify({ servers: { example: { command: "node", args: ["server.mjs"], network: false } } }));
    assert.equal(readServers(agent, cwd).example.command, "node");
    assert.throws(() => readServers(agent, root), /outside/);
    writeFileSync(path, JSON.stringify({ servers: { remote: { url: "https://example.com/mcp" } } }));
    assert.throws(() => readServers(agent, cwd), /local stdio/);
    rmSync(path); symlinkSync(join(cwd, "mcp.json"), path);
    assert.throws(() => readServers(agent, cwd));
    assert.equal(CONFINED_TOOLS.has("dunst"), false, "host automation never inherited by confined subagents");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dunst executes only the exact human-confirmed request; refusal, headless, abort and stale approvals never call the server", async t => {
  const calls = [];
  t.mock.method(McpConnection.prototype, "call", async function (name, args) {
    calls.push({ name, args }); return { content: [{ type: "text", text: "fixture" }], details: undefined };
  });
  const handlers = new Map(); let tool;
  dunst({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand() {} });
  const ctx = { cwd: tmpdir(), hasUI: true, ui: { confirm: async () => false } };
  const execute = (params, signal) => tool.execute("fixture", params, signal, undefined, ctx);
  await assert.rejects(execute({ tool: "click", args: { id: "button" } }), /not approved/);
  ctx.hasUI = false;
  await assert.rejects(execute({ tool: "help" }), /interactive/);
  ctx.hasUI = true;
  await assert.rejects(execute({ tool: "click" }, AbortSignal.abort()));
  const request = { tool: "type_into", args: { text: "approved" } };
  ctx.ui.confirm = async (_title, message) => { assert.match(message, /approved/); request.args.text = "not approved"; return true; };
  await execute(request);
  assert.deepEqual(calls, [{ name: "type_into", args: { text: "approved" } }]);
  let decide;
  ctx.ui.confirm = () => new Promise(resolve => { decide = resolve; });
  const pending = execute({ tool: "submit", args: { form: "payment" } });
  await handlers.get("session_before_switch")();
  decide(true);
  await assert.rejects(pending);
  assert.equal(calls.length, 1);
  await handlers.get("session_shutdown")();
});
