import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { runInstall, PACKAGE_DIRECTORY } from "../scripts/install.mjs";
import { installedPackageRoot, isManagedPackage, RELEASES_DIRECTORY } from "../lib/runtime-paths.mjs";
import { activationState, requiresRestart } from "../lib/harness-activation.mjs";
import { buildFixtureSource } from "./fixtures/build.mjs";

async function fixture(t) {
  const source = await buildFixtureSource({ settings: { packages: [] } });
  const root = await mkdtemp(join(tmpdir(), "pi-releases-")), target = join(root, "agent"), cwd = join(root, "project");
  await mkdir(cwd);
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); });
  const install = (options = {}, dependencies) => runInstall({ sourceRoot: source, target, noPackages: true, hotReload: true, ...options }, dependencies);
  return { source, root, target, cwd, install };
}

test("a real SDK session reloads nested .mjs dependencies from a new release and preserves its history", async t => {
  const f = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.target;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(join(f.source, "lib/helper.mjs"), "export { version } from './nested.mjs';\n");
  await writeFile(join(f.source, "lib/nested.mjs"), "export const version = 'v1';\n");
  await writeFile(join(f.source, "extensions/demo/index.ts"), `
import { version } from '../../lib/helper.mjs';
export default function(pi) {
  pi.registerTool({ name:'probe', label:'probe', description:'fixture', parameters:{type:'object',properties:{}},
    async execute() { return { content:[{type:'text',text:version}], details:undefined }; } });
  pi.registerCommand('probe', { handler:async(_,ctx)=>ctx.ui.notify(version) });
}`);
  const first = await f.install(), before = activationState(f.target);
  const settingsManager = SettingsManager.create(f.cwd, f.target);
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.target, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const probe = () => loader.getExtensions().extensions[0].tools.get("probe").definition.execute("fixture", {});
  const oldTool = loader.getExtensions().extensions[0].tools.get("probe").definition;
  assert.equal((await probe()).content[0].text, "v1");
  const runtime = await ModelRuntime.create({ authPath: join(f.target, "auth.json"), modelsPath: null,
    modelsStorePath: join(f.target, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const sessionManager = SessionManager.inMemory(f.cwd);
  sessionManager.appendMessage({ role: "user", content: "Keep this conversation", timestamp: Date.now() });
  const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.target, modelRuntime: runtime,
    resourceLoader: loader, settingsManager, sessionManager, tools: ["probe"] });
  try {
    const id = sessionManager.getSessionId(), history = sessionManager.getEntries();
    await writeFile(join(f.source, "lib/nested.mjs"), "export const version = 'v2';\n");
    const second = await f.install({ hotReload: false }); // Sticky migration also covers older callers.
    assert.notEqual(second.packageRoot, first.packageRoot);
    assert.equal(requiresRestart(before, activationState(f.target)), false);
    assert.equal((await probe()).content[0].text, "v1", "publishing does not modify a running session");
    assert.match(await readFile(join(first.packageRoot, "lib/nested.mjs"), "utf8"), /v1/);
    await session.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal((await probe()).content[0].text, "v2", "native /reload refreshes the nested ESM graph");
    assert.equal((await oldTool.execute("old", {})).content[0].text, "v1", "old references retain their original release");
    assert.equal(sessionManager.getSessionId(), id);
    assert.deepEqual(sessionManager.getEntries(), history);
    assert.equal(loader.getExtensions().extensions.length, 1, "no duplicate tools or commands");
    assert.equal(settingsManager.getShellPath(), join(second.packageRoot, "scripts/codex-shell.mjs"));
    assert.equal((await f.install()).packageRoot, second.packageRoot, "identical install reuses its release");
  } finally { session.dispose(); }
});

test("legacy migration preserves old runtime files and replaces only the selected package entry", async t => {
  const f = await fixture(t);
  const old = await f.install({ hotReload: false });
  const oldCode = await readFile(join(old.packageRoot, "extensions/demo/index.ts"), "utf8");
  await writeFile(join(f.source, "extensions/demo/index.ts"), "export default function() {}\n");
  const next = await f.install();
  assert.equal(old.packageRoot, join(f.target, PACKAGE_DIRECTORY));
  assert.equal(await readFile(join(old.packageRoot, "extensions/demo/index.ts"), "utf8"), oldCode);
  const settings = JSON.parse(await readFile(join(f.target, "settings.json")));
  assert.deepEqual(settings.packages, [next.packageRoot]);
  assert.equal(installedPackageRoot(f.target), next.packageRoot);
  assert.equal(next.restartRequired, false);
});

test("failed activation leaves settings and the previous release usable; the install lock is released", async t => {
  const f = await fixture(t), first = await f.install();
  const settings = await readFile(join(f.target, "settings.json"), "utf8");
  await writeFile(join(f.source, "lib/helper.ts"), "export const changed = true;\n");
  await assert.rejects(f.install({}, { renameSettings: async () => { throw new Error("fixture activation failure"); } }), /activation failure/);
  assert.equal(await readFile(join(f.target, "settings.json"), "utf8"), settings);
  assert.equal(installedPackageRoot(f.target), first.packageRoot);
  assert.ok(!(await readdir(join(f.target, RELEASES_DIRECTORY))).some(name => name.startsWith(".stage-")));
  assert.notEqual((await f.install()).packageRoot, first.packageRoot);
});

test("tampered releases, symlinked release storage and ambiguous selection fail before activation", async t => {
  const f = await fixture(t), first = await f.install();
  const settings = await readFile(join(f.target, "settings.json"), "utf8");
  await writeFile(join(first.packageRoot, "lib/helper.ts"), "tampered\n");
  await assert.rejects(f.install(), /release was modified/);
  assert.equal(await readFile(join(f.target, "settings.json"), "utf8"), settings);
  await symlink(f.source, join(first.packageRoot, "escape"));
  await assert.rejects(f.install(), /symbolic link/);
  assert.equal(isManagedPackage(f.target, join(f.target, RELEASES_DIRECTORY, "../outside")), false);
  assert.throws(() => installedPackageRoot(f.target, { packages: [first.packageRoot, first.packageRoot] }), /Multiple/);
});

test("concurrent installers cannot replace each other's settings or remove each other's lock", async t => {
  const f = await fixture(t);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const first = f.install({}, { renameSettings: async () => { entered(); await hold; throw new Error("fixture stopped"); } });
  await waiting;
  try { await assert.rejects(f.install(), /another harness install/); }
  finally { release(); }
  await assert.rejects(first, /fixture stopped/);
  await f.install();
});

test("external dependency changes remain a restart even when the harness uses releases", async t => {
  const f = await fixture(t);
  await f.install();
  const dir = join(f.target, "npm/node_modules/fixture");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "index.mjs"), "export const version = 1;\n");
  const before = activationState(f.target);
  await writeFile(join(dir, "index.mjs"), "export const version = 2;\n");
  assert.equal(requiresRestart(before, activationState(f.target)), true);
});

test("activation merges settings saved by an open SDK session while the release is copied", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.install();
  const manager = SettingsManager.create(f.cwd, f.target);
  manager.setTheme("before");
  await manager.flush();
  // Many small files keep the copy phase observable without timing assumptions.
  for (let i = 0; i < 40; i++) await writeFile(join(f.source, "lib", `helper-${i}.ts`), `export const n = ${i};\n`);
  const pending = f.install();
  while (!(await readdir(join(f.target, RELEASES_DIRECTORY))).some(name => name.startsWith(".stage-"))) await delay(1);
  manager.setTheme("during-copy");
  await manager.flush();
  const result = await pending;
  const settings = JSON.parse(await readFile(join(f.target, "settings.json")));
  assert.equal(settings.theme, "during-copy");
  assert.equal(settings.packages[0], result.packageRoot);
  // The SDK also preserves the new release when saving its next setting.
  manager.setTheme("after");
  await manager.flush();
  assert.equal(installedPackageRoot(f.target), result.packageRoot);
  assert.ok(!(await readdir(f.target)).includes("settings.json.lock"));
});

test("activation respects the SDK settings lock without deleting another writer's lock", async t => {
  const f = await fixture(t), first = await f.install();
  const path = join(f.target, "settings.json"), before = await readFile(path, "utf8");
  await mkdir(`${path}.lock`);
  await writeFile(join(f.source, "lib/helper.ts"), "export const changed = true;\n");
  await assert.rejects(f.install(), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(installedPackageRoot(f.target), first.packageRoot);
  assert.ok((await readdir(f.target)).includes("settings.json.lock"));
  await rm(`${path}.lock`, { recursive: true });
  await f.install();
});
