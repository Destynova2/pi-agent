import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import register from "../extensions/confined-lsp/index.ts";

test("LSP host preserves interactive enablement, post-edit entries and session restoration inside Codex", { timeout: 45000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-host-")));
  const realAgent = getAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  symlinkSync(join(realAgent, "npm"), join(agent, "npm"));
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ lsp: { servers: { fake: {
    command: process.execPath, args: [fileURLToPath(new URL("confined-lsp-fixtures/fake-lsp-server.mjs", import.meta.url))],
    environment: { PI_CODING_AGENT_DIR: realAgent }, languages: [{ extensions: [".txt"], languageId: "plaintext" }],
  } } } }));
  process.env.PI_CODING_AGENT_DIR = agent;
  const events = new Map(), branch = [], notifications = [], selections = [];
  let tool, command, renderEntry;
  register({
    on: (name, handler) => events.set(name, handler), registerTool: value => { tool = value; },
    registerCommand: (_name, value) => { command = value; }, registerEntryRenderer: (_name, value) => { renderEntry = value; },
    appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
  });
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      select: async (title, options) => { selections.push(title); return options.includes("disable") ? "disable" : options[0]; },
    },
  };
  const call = input => tool.execute("fixture", input, undefined, undefined, ctx);
  try {
    await events.get("session_start")({}, ctx);
    assert.match((await call({ operation: "hover", file_path: "a.txt", line: 1, character: 1 })).content[0].text, /fake hover/);
    await command.handler("", ctx);
    assert.equal(selections.length, 3);
    assert.ok(branch.some(entry => entry.customType === "pi-lsp-enablement" && entry.data.enabled === false));
    assert.equal((await call({ operation: "hover", file_path: "a.txt", line: 1, character: 1 })).isError, true);
    await events.get("session_before_tree")({}, ctx);
    await events.get("session_tree")({}, ctx);
    assert.equal((await call({ operation: "hover", file_path: "a.txt", line: 1, character: 1 })).isError, true);
    await command.handler("enable fake", ctx);
    const patch = await events.get("tool_result")({
      toolName: "write", input: { path: "a.txt", content: "hello\n" },
      content: [{ type: "text", text: "written" }], details: {}, isError: false,
    }, ctx);
    assert.match(JSON.stringify(patch), /fixture diagnostic/);
    await events.get("turn_end")({}, ctx);
    const diagnosticsEntry = branch.find(entry => entry.customType === "pi-lsp-post-edit-diagnostics");
    assert.ok(diagnosticsEntry);
    assert.match(renderEntry(diagnosticsEntry).render(120).join("\n"), /fixture\s+diagnostic/);
    assert.match(renderEntry({ data: { outcomes: [{ kind: "warning", message: "fixture warning" }] } }).render(120).join("\n"), /fixture warning/);
    assert.ok((await command.getArgumentCompletions("disable ")).some(item => item.value === "disable fake"));
    assert.equal(notifications.filter(item => item.level === "error").length, 0, JSON.stringify(notifications));
  } finally {
    await events.get("session_shutdown")({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
