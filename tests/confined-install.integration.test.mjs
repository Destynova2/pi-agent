import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PACKAGE_DIRECTORY, runInstall } from "../scripts/install.mjs";

test("isolated installation loads confined adapters without host LSP hooks or a builtin MCP collision", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-confined-install-")));
  const target = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const live = getAgentDir();
  try {
    await runInstall({ sourceRoot: fileURLToPath(new URL("..", import.meta.url)), target, noPackages: true });
    symlinkSync(join(live, "npm"), join(target, "npm"));
    process.env.PI_CODING_AGENT_DIR = target;
    const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
    const lspPackage = settings.packages.find(entry => entry.source?.includes("pi-lsp"));
    assert.deepEqual(lspPackage?.extensions, []);
    assert.ok(settings.extensions.includes("-builtin:mcp"));
    assert.ok(existsSync(join(target, PACKAGE_DIRECTORY, "scripts/confined-lsp-worker.mjs")));
    // Reuse installed dependency files; fail instead of ever downloading or running install scripts.
    const isolatedSettings = { ...settings, packages: [join(target, PACKAGE_DIRECTORY), lspPackage], npmCommand: ["/usr/bin/false"] };
    writeFileSync(join(target, "settings.json"), JSON.stringify(isolatedSettings));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: target, settingsManager: SettingsManager.inMemory(isolatedSettings),
      noExtensions: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: "mcp", builtin: true, replaceable: true, factory() { throw new Error("The shadowed host MCP builtin must not load"); } }],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    for (const name of ["ci_watch", "dunst", "lsp", "mcp", "web_fetch", "web_search", "task_checkpoint", "request_podman_access"]) {
      assert.equal(loaded.extensions.filter(extension => extension.tools.has(name)).length, 1, `${name}: exactly one executor, no upstream host hooks`);
    }
    const lsp = loaded.extensions.find(extension => extension.tools.has("lsp"));
    const ctx = { cwd, hasUI: false, isProjectTrusted: () => false, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
    try {
      for (const handler of lsp.handlers.get("session_start")) await handler({}, ctx);
      // Registration, worker resolution and real package loading must work from the installed target.
      for (const handler of lsp.handlers.get("turn_end")) await handler({}, ctx);
    } finally { for (const handler of lsp.handlers.get("session_shutdown")) await handler({}, ctx); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
