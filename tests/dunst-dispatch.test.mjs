import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// Dunst acts on the host with the user's real applications. The strict dispatcher lets the call reach the
// tool (which asks the human itself) only in the interactive parent; headless runs and children stay denied.
test("the strict dispatcher passes dunst only in the interactive parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dunst-dispatch-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR, child = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    mkdirSync(agent); mkdirSync(cwd);
    writeFileSync(join(agent, "tool-policy.json"), '{"*":"allow"}');
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: new URL("../scripts/codex-shell.mjs", import.meta.url).pathname }));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: agent, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [new URL("../extensions/tool-policy/index.ts", import.meta.url).pathname],
    });
    await loader.reload();
    const extension = loader.getExtensions().extensions[0];
    const ctx = { cwd, hasUI: true, isProjectTrusted: () => false, ui: { notify() {}, confirm() { assert.fail("no prompts"); }, select() { assert.fail("no prompts"); } } };
    for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
    const call = () => extension.handlers.get("tool_call")[0]({ toolName: "dunst", input: { tool: "screenshot" } }, ctx);
    assert.equal(await call(), undefined, "interactive parent: the tool's own human dialog decides");
    ctx.hasUI = false;
    assert.match((await call()).reason, /no confined executor/, "headless: denied");
    ctx.hasUI = true;
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.match((await call()).reason, /no confined executor/, "child: denied");
    assert.match((await extension.handlers.get("tool_call")[0]({ toolName: "unknown", input: {} }, ctx)).reason, /no confined executor/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child;
    rmSync(root, { recursive: true, force: true });
  }
});
