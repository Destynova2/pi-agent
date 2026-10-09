import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mcp from "../extensions/mcp/index.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";

// Consent adapter only; browser-mcp.integration.test.mjs exercises the real container.
function fixture(select = async () => APPROVAL_CHOICES[3]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-browser-consent-")));
  const cwd = join(root, "project"), agent = join(root, "agent"); mkdirSync(cwd); mkdirSync(agent);
  const previousAgent = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const handlers = new Map(), commands = new Map(), prompts = [], calls = [], processes = [];
  let tool;
  const catalog = ["browser_run_code_unsafe", "browser_click"].map(name => ({ name, inputSchema: { type: "object" } }));
  const config = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--isolated"], network: false, browser: { image: `sha256:${"a".repeat(64)}` } } } };
  const save = () => writeFileSync(join(agent, "mcp.json"), JSON.stringify(config)); save();
  mcp({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => commands.set(name, value), registerTool: value => { tool = value; } }, async () => ({
    identity: "fixture-engine", detail: "Isolated browser fixture", verify() {},
    async start(authorized) {
      authorized();
      const rpc = {
        alive: true, start() {}, notify() {}, async shutdown() { this.alive = false; },
        async request(method, params) {
          assert.equal(this.alive, true);
          if (method === "initialize") return {};
          if (method === "tools/list") return { tools: structuredClone(catalog) };
          assert.equal(method, "tools/call"); calls.push(params);
          return { content: [{ type: "text", text: "ok" }] };
        },
      };
      processes.push(rpc); return rpc;
    },
  }));
  const ctx = { cwd, hasUI: true, ui: {
    select: async (prompt, choices, options) => { prompts.push(prompt); assert.deepEqual(choices, APPROVAL_CHOICES); return select(prompt, choices, options); },
    confirm: async () => true, notify() {},
  } };
  return {
    root, cwd, agent, ctx, commands, handlers, prompts, calls, processes, catalog, config, save,
    call: (args = {}, name = "browser_run_code_unsafe") => tool.execute("fixture", { server: "playwright", tool: name, args }, undefined, undefined, ctx),
    async close() {
      try { await handlers.get("session_shutdown")(); }
      finally {
        if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test("isolated browser project consent covers a tool's parameters across sessions, but no other tool or project", async () => {
  const f = fixture();
  try {
    await f.call({ code: "first" });
    assert.equal(f.prompts.length, 2, "separate launch and tool consent");
    assert.match(f.prompts[1], /tous ses paramètres/);
    assert.match(f.prompts[1], /modifier les sites visités ou envoyer des données/);
    await f.call({ code: "second" });
    await f.handlers.get("session_start")();
    await f.call({ code: "third" });
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.calls.map(call => call.arguments.code), ["first", "second", "third"]);
    const db = new DatabaseSync(join(f.agent, "permission-audit/requests.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT source, scope, status FROM permission_requests WHERE resource='mcp:playwright' ORDER BY rowid").all().map(row => ({ ...row })), ["human", "project", "project"].map(source => ({ source, scope: "project", status: "granted" })));
    } finally { db.close(); }
    await f.call({ ref: "button" }, "browser_click");
    assert.equal(f.prompts.length, 3);
    const other = join(f.root, "other-project"); mkdirSync(other); f.ctx.cwd = other;
    await f.call({ code: "other project" });
    assert.equal(f.prompts.length, 5);
  } finally { await f.close(); }
});

test("browser once and session choices retain their exact lifetimes", async () => {
  for (const scope of [1, 2]) {
    const f = fixture(async () => APPROVAL_CHOICES[scope]);
    try {
      await f.call(); await f.call({ code: "another request" });
      assert.equal(f.prompts.length, scope === 1 ? 3 : 2);
      await f.handlers.get("session_start")(); await f.call();
      assert.equal(f.prompts.length, scope === 1 ? 5 : 4);
    } finally { await f.close(); }
  }
});

test("browser project consent cannot survive image, tool manifest or revocation changes", async () => {
  const f = fixture();
  try {
    await f.call();
    f.catalog[0].description = "changed semantics";
    await assert.rejects(f.call({ code: "stale manifest" }), /definition changed/);
    assert.equal(f.calls.length, 1);
    await f.call(); assert.equal(f.prompts.length, 3, "changed tool requires a new grant");
    f.config.mcpServers.playwright.browser.image = `sha256:${"b".repeat(64)}`; f.save();
    await f.call(); assert.equal(f.prompts.length, 5, "changed image requires launch and tool consent");
    await f.commands.get("mcp").handler("permissions playwright", f.ctx);
    assert.equal(f.processes.at(-1).alive, false);
    await f.call(); assert.equal(f.prompts.length, 7);
    new McpApprovals(f.agent).revoke(f.cwd, "mcp:playwright");
    await f.call(); assert.equal(f.prompts.length, 8, "another process can revoke the tool grant");
  } finally { await f.close(); }
});

test("remembered browser control still requires the interactive parent and cannot be delegated", async () => {
  const f = fixture();
  const oldChild = process.env.PI_SUBAGENT_CHILD;
  try {
    await f.call(); f.ctx.hasUI = false;
    await assert.rejects(f.call({ code: "headless" }), /interactive parent/);
    f.ctx.hasUI = true; process.env.PI_SUBAGENT_CHILD = "1";
    await assert.rejects(f.call({ code: "delegated" }), /parent session/);
    assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 2);
  } finally {
    if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
    await f.close();
  }
});

test("revocation during browser tool confirmation prevents dispatch and a late saved grant", async () => {
  let f;
  f = fixture(async prompt => {
    if (prompt.includes("browser_run_code_unsafe")) new McpApprovals(f.agent).revoke(f.cwd, "mcp:playwright");
    return APPROVAL_CHOICES[3];
  });
  try {
    await assert.rejects(f.call(), /revoked/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.call(), /revoked/);
    assert.equal(f.prompts.length, 3, "late consent did not persist");
  } finally { await f.close(); }
});
