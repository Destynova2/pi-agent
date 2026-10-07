import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mcp, { readServers } from "../extensions/mcp/index.ts";
import { McpConnection } from "../extensions/mcp/client.ts";
import { RpcProcess } from "../lib/rpc-process.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-dynamic-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  });
  return { agent, cwd, save: data => writeFileSync(join(agent, "mcp.json"), JSON.stringify(data)) };
}

test("native CLI definitions coexist with legacy servers and normalize only supported stdio settings", t => {
  const { agent, cwd, save } = fixture(t);
  save({ servers: { immo: { command: "node", args: [] } }, mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--isolated"] },
    offline: { type: "stdio", command: "node", network: false, exposure: "codemode", description: "Local", env: { LITERAL: "${TOKEN} !command" } },
    disabled: { command: "node", enabled: false },
  } });
  assert.deepEqual(readServers(agent, cwd), {
    immo: { command: "node", args: [] },
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--isolated"], network: true },
    offline: { command: "node", args: [], network: false, env: { LITERAL: "${TOKEN} !command" } },
  });
  save(JSON.parse('{"mcpServers":{"__proto__":{"command":"node"}}}'));
  assert.equal(Object.hasOwn(readServers(agent, cwd), "__proto__"), true);
});

test("native unsupported transports, exposure controls, malformed fields and ambiguous names fail closed", t => {
  const { agent, cwd, save } = fixture(t);
  for (const extra of [
    { url: "https://example.com/mcp" }, { type: "http" }, { cwd }, { timeout: 5000 },
    { exposure: "direct" }, { exposure: "hidden" }, { toolExposure: { send: "hidden" } },
    { enabled: "false" }, { description: 3 }, { network: "true" }, { env: { BAD: 1 } },
    { args: null }, { args: [1] }, { command: "" },
  ]) {
    save({ mcpServers: { fixture: { command: "node", ...extra } } });
    assert.throws(() => readServers(agent, cwd), /local stdio/);
  }
  for (const data of [null, [], {}, { servers: null }, { mcpServers: [] }]) {
    save(data); assert.throws(() => readServers(agent, cwd), /Expected MCP/);
  }
  save({ servers: { same: { command: "node", args: [] } }, mcpServers: { same: { command: "node", enabled: false } } });
  assert.throws(() => readServers(agent, cwd), /unique/);
});

test("adding, changing, disabling and removing servers takes effect on the next call without stopping unchanged connections", async t => {
  const { cwd, save } = fixture(t);
  const legacy = { command: process.execPath, args: [] };
  const native = { command: process.execPath, args: ["--version"] };
  save({ servers: { legacy } });
  const opened = [], closed = [], handlers = new Map(); let tool;
  t.mock.method(McpConnection.prototype, "start", async function () {
    if (!opened.includes(this)) {
      opened.push(this);
      Object.defineProperty(this.rpc, "alive", { get: () => !closed.includes(this.rpc) });
    }
  });
  t.mock.method(RpcProcess.prototype, "shutdown", async function () { closed.push(this); });
  t.mock.method(McpConnection.prototype, "call", async function () { return { content: [{ type: "text", text: String(opened.indexOf(this)) }] }; });
  mcp({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand() {} });
  const execute = params => tool.execute("fixture", params, undefined, undefined, { cwd, hasUI: false });
  try {
    await execute({ server: "legacy" });
    save({ servers: { legacy }, mcpServers: { native } });
    assert.deepEqual(JSON.parse((await execute({})).content[0].text), ["legacy", "native"]);
    await execute({ server: "native" }); await execute({ server: "legacy" });
    assert.equal(opened.length, 2); assert.equal(closed.length, 0);
    native.args = ["--help"];
    save({ servers: { legacy }, mcpServers: { native } });
    await execute({});
    assert.deepEqual(closed, [opened[1].rpc]);
    await execute({ server: "native" });
    save({ servers: { legacy }, mcpServers: { native: { ...native, enabled: false } } });
    await assert.rejects(execute({ server: "native" }), /Unknown MCP/);
    assert.equal(closed.length, 2);
    save({ servers: { legacy }, mcpServers: { native } });
    await execute({ server: "native" });
    save({ servers: { legacy }, mcpServers: {} });
    await execute({});
    assert.equal(closed.length, 3);
    await execute({ server: "legacy" });
    assert.equal(opened.length, 4, "legacy connection stayed open across every configuration update");
  } finally { await handlers.get("session_shutdown")(); }
});
