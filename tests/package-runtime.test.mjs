import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PACKAGE_DIRECTORY, runInstall } from "../scripts/install.mjs";
import { buildFixtureSource } from "./fixtures/build.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));

test("native manifest loads each shipped extension once after migrating legacy copies", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-loader-")), target = join(root, "agent"), cwd = join(root, "project");
  const live = getAgentDir(), previous = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd);
  await mkdir(join(target, "extensions/task-progress"), { recursive: true });
  await writeFile(join(target, "extensions/task-progress/index.ts"), "throw new Error('LEGACY_LOADED');");
  await writeFile(join(target, "extensions/personal.ts"), "export default function(pi) { pi.registerCommand('personal', { description: 'fixture', handler: async () => {} }); }");
  await writeFile(join(target, "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
  const installed = await runInstall({ sourceRoot: source, target, noPackages: true });
  assert.equal(await readFile(join(installed.backupDir, "extensions/task-progress/index.ts"), "utf8"), "throw new Error('LEGACY_LOADED');");
  await assert.rejects(readFile(join(target, "extensions/task-progress/index.ts")), { code: "ENOENT" });
  // Simulate interruption after settings activation, before legacy cleanup.
  await writeFile(join(target, "extensions/task-progress/index.ts"), "throw new Error('LEGACY_LOADED');");
  await symlink(join(live, "npm"), join(target, "npm"));
  const settings = JSON.parse(await readFile(join(target, "settings.json"), "utf8"));
  const packageRoot = join(target, PACKAGE_DIRECTORY);
  settings.packages = [packageRoot];
  settings.npmCommand = ["/usr/bin/false"];
  await writeFile(join(target, "settings.json"), JSON.stringify(settings));
  process.env.PI_CODING_AGENT_DIR = target;
  const loader = new DefaultResourceLoader({ cwd, agentDir: target, settingsManager: SettingsManager.inMemory(settings),
    extensionFactories: [{ name: "mcp", builtin: true, replaceable: true, factory() { throw new Error("Builtin host MCP must remain disabled"); } }],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  for (let i = 0; i < 2; i++) {
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(loaded.extensions.length, manifest.pi.extensions.length + 1);
    for (const tool of ["task_checkpoint", "subagent", "read", "bash_background", "bash_process", "lsp", "mcp"]) {
      assert.equal(loaded.extensions.filter(extension => extension.tools.has(tool)).length, 1, tool);
    }
    assert.equal(loaded.extensions.some(extension => extension.tools.has("bash")), false, "foreground Bash stays native");
    assert.ok(loaded.extensions.some(extension => extension.commands.has("personal")));
  }
});

test("package storage and manifest links are rejected before migration writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-links-")), fixture = await buildFixtureSource();
  const target = join(root, "agent"), outside = join(root, "outside");
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true }); });
  await mkdir(target); await mkdir(outside);
  await symlink(outside, join(target, "packages"));
  await assert.rejects(runInstall({ sourceRoot: fixture, target, noPackages: true }), /symbolic link/);
  await assert.rejects(readFile(join(target, "settings.json")), { code: "ENOENT" });
  await rm(join(target, "packages"));
  await writeFile(join(outside, "package.json"), await readFile(join(fixture, "package.json")));
  await rm(join(fixture, "package.json"));
  await symlink(join(outside, "package.json"), join(fixture, "package.json"));
  await assert.rejects(runInstall({ sourceRoot: fixture, target, noPackages: true }), /symbolic link/);
  await assert.rejects(readFile(join(target, "settings.json")), { code: "ENOENT" });
});
