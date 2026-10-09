import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("real Pi loader registers confined file tools and fails closed without an adapter, even after reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-strict-loader-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    mkdirSync(agent); mkdirSync(cwd);
    writeFileSync(join(agent, "tool-policy.json"), '{"*":"allow"}');
    const loader = new DefaultResourceLoader({
      cwd, agentDir: agent, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      assert.deepEqual([...extension.tools.keys()].sort(), ["edit", "find", "git_access", "git_repository_init", "git_worktree_cleanup", "grep", "jj_checkpoint", "ls", "model_catalog", "read", "request_build_access", "request_command_access", "request_host_access", "request_network_access", "request_podman_access", "run_isolated", "write"]);
      const ctx = { cwd, isProjectTrusted: () => false, hasUI: false, ui: {
        confirm() { assert.fail("No approval prompts"); }, select() { assert.fail("No task grants"); },
      } };
      for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
      for (const name of ["read", "write", "bash", "bash_process", "subagent", "lsp", "note_add", "web_fetch", "git_repository_init", "git_worktree_cleanup", "unknown"]) {
        const result = await extension.handlers.get("tool_call")[0]({ toolName: name, input: {} }, ctx);
        assert.equal(result.block, true, name);
        assert.doesNotMatch(result.reason, /requires user confirmation/);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
