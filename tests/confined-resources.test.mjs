import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PACKAGE_DIRECTORY, runInstall } from "../scripts/install.mjs";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

// Registration only: no session hooks, model calls, server launches or network access.
// Real worker startup and filesystem denial remain mandatory integration tests.
test("installed resources register every confined adapter once and filter upstream LSP hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resources-"));
  const target = join(root, "agent"), cwd = join(root, "project");
  const live = getAgentDir(), previous = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(cwd);
  try {
    await runInstall({ sourceRoot: fileURLToPath(new URL("..", import.meta.url)), target, noPackages: true });
    symlinkSync(join(live, "npm"), join(target, "npm"));
    process.env.PI_CODING_AGENT_DIR = target;
    const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
    const lsp = settings.packages.find(p => p.source?.includes("pi-lsp"));
    assert.deepEqual(lsp.extensions, []);
    const isolated = { ...settings, packages: [join(target, PACKAGE_DIRECTORY), lsp], npmCommand: ["/usr/bin/false"] };
    writeFileSync(join(target, "settings.json"), JSON.stringify(isolated));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: target, settingsManager: SettingsManager.inMemory(isolated),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const tools = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
    for (const name of CONFINED_TOOLS) {
      if (name === "bash") continue; // Pi's native foreground tool.
      assert.equal(tools.filter(tool => tool === name).length, 1, `${name}: exactly one confined adapter`);
    }
    assert.equal(loaded.extensions.filter(extension => extension.tools.has("lsp")).length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
