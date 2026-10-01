import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInstall, MANAGED_DIRS } from "../scripts/install.mjs";
import { buildFixtureSource, makeFakePi, makeTmpDir } from "./fixtures/build.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("sandbox launcher is installed executable, backed up, and refuses symlinked parents", async () => {
  const source = await buildFixtureSource();
  const parent = await makeTmpDir("pi-agent-launcher-");
  const target = join(parent, "agent");
  const outside = join(parent, "outside");
  const relative = "scripts/codex-shell.mjs";
  try {
    await mkdir(join(source, "scripts"));
    await writeFile(join(source, relative), "#!/usr/bin/env node\n");
    await writeFile(join(source, "scripts/codex-tool.mjs"), "// confined file worker\n");
    await writeFile(join(source, "scripts/codex-network.mjs"), "// managed network policy\n");
    await writeFile(join(source, "scripts/confined-tool.mjs"), "// confined service worker\n");
    await chmod(join(source, relative), 0o644); // installer must set executable mode itself
    await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal((await stat(join(target, relative))).mode & 0o777, 0o755);
    assert.equal((await readJson(join(target, "settings.json"))).shellPath, join(target, relative));
    assert.equal(await readFile(join(target, "scripts/codex-tool.mjs"), "utf8"), "// confined file worker\n");
    await writeFile(join(target, relative), "previous launcher\n");
    await writeFile(join(target, "scripts/personal.mjs"), "keep\n");
    await writeFile(join(target, "tool-policy.json"), '{"bash":"deny"}\n');
    await mkdir(join(target, "extensions/tool-policy"), { recursive: true });
    await writeFile(join(target, "extensions/tool-policy/core.ts"), "// legacy parser\n");
    await writeFile(join(target, "network-policy.json"), '{"allow":[]}\n');
    await writeFile(join(target, "settings.json"), '{"shellPath":"/bin/bash","theme":"dark"}');
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(await readFile(join(result.backupDir, relative), "utf8"), "previous launcher\n");
    assert.equal(await readFile(join(target, relative), "utf8"), "#!/usr/bin/env node\n");
    assert.equal(await readFile(join(target, "scripts/personal.mjs"), "utf8"), "keep\n");
    assert.equal(await readFile(join(result.backupDir, "tool-policy.json"), "utf8"), '{"bash":"deny"}\n');
    assert.equal(await readFile(join(result.backupDir, "extensions/tool-policy/core.ts"), "utf8"), "// legacy parser\n");
    await assert.rejects(readFile(join(target, "tool-policy.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(target, "extensions/tool-policy/core.ts")), { code: "ENOENT" });
    assert.equal(await readFile(join(target, "scripts/confined-tool.mjs"), "utf8"), "// confined service worker\n");
    assert.equal(await readFile(join(target, "network-policy.json"), "utf8"), '{"allow":[]}\n');
    assert.equal(await readFile(join(target, "scripts/codex-network.mjs"), "utf8"), "// managed network policy\n");
    assert.equal((await readJson(join(target, "settings.json"))).shellPath, join(target, relative));
    assert.equal((await readJson(join(result.backupDir, "settings.json"))).shellPath, "/bin/bash");
    await mkdir(outside);
    for (const root of [target, source]) {
      await rm(join(root, "scripts"), { recursive: true });
      await symlink(outside, join(root, "scripts"));
      await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /symbolic link/);
      await rm(join(root, "scripts"));
      await mkdir(join(root, "scripts"));
    }
    await assert.rejects(readFile(join(outside, "codex-shell.mjs")), { code: "ENOENT" });
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("fresh install copies managed resources and writes the source's settings.json", async () => {
  const source = await buildFixtureSource();
  const target = join(await makeTmpDir("pi-agent-target-"), "agent");
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(result.target, target);
    assert.equal(result.backupDir, null, "nothing to back up on a fresh target");
    assert.deepEqual(result.syncedDirs.sort(), [...MANAGED_DIRS].sort());
    for (const dir of MANAGED_DIRS) {
      await readFile(join(target, dir === "agents" ? "agents/worker.md" : dir === "extensions" ? "extensions/demo/index.ts" : dir === "lib" ? "lib/helper.ts" : "gates/pi-prek"), "utf8");
    }
    const settings = await readJson(join(target, "settings.json"));
    assert.deepEqual(settings.packages, ["npm:pkg-a", "npm:pkg-b"]);
    assert.equal(settings.defaultProvider, "anthropic");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("reinstall keeps existing preferences, replaces managed packages by identity, preserves personal packages and out-of-scope files", async () => {
  const source = await buildFixtureSource({ settings: { defaultProvider: "anthropic", packages: ["npm:pkg-a@2.0.0"] } });
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "settings.json"),
    `${JSON.stringify({ theme: "dark", packages: ["npm:pkg-a@1.0.0", "npm:perso-pkg"] }, null, 2)}\n`,
  );
  await writeFile(join(target, "keybindings.json"), "{}\n");
  await writeFile(join(target, "notes-custom.txt"), "to preserve\n");
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.ok(result.backupDir, "a backup must be created when resources already exist");
    const backupSettings = await readJson(join(result.backupDir, "settings.json"));
    assert.deepEqual(backupSettings.packages, ["npm:pkg-a@1.0.0", "npm:perso-pkg"], "the backup contains the old state");

    const settings = await readJson(join(target, "settings.json"));
    assert.equal(settings.theme, "dark", "existing preference kept");
    assert.deepEqual(
      settings.packages,
      ["npm:pkg-a@2.0.0", "npm:perso-pkg"],
      "managed package (same identity) replaced by the source version, personal package preserved",
    );
    assert.equal(settings.defaultProvider, "anthropic", "new key from the source added");
    assert.deepEqual(result.packages, ["npm:pkg-a@2.0.0"], "only the source's managed packages are offered for install");

    assert.equal(await readFile(join(target, "notes-custom.txt"), "utf8"), "to preserve\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("secrets and private state are never touched by the installer", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(join(target, "sessions"), { recursive: true });
  await writeFile(join(target, "auth.json"), '{"secret":"do-not-touch"}\n');
  await writeFile(join(target, "models-store.json"), "{}\n");
  await writeFile(join(target, "trust.json"), "{}\n");
  await writeFile(join(target, "sessions", "s1.jsonl"), "{}\n");
  try {
    await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(await readFile(join(target, "auth.json"), "utf8"), '{"secret":"do-not-touch"}\n');
    assert.equal(await readFile(join(target, "models-store.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(target, "trust.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(target, "sessions", "s1.jsonl"), "utf8"), "{}\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("skills/ is not managed: a live symlink (e.g. a cli-code-skills checkout) survives install without double activation", async () => {
  // `skills` is deliberately absent from MANAGED_DIRS/MANAGED_ENTRIES: Pi scans it
  // natively (~/.pi/agent/skills), it is not part of this installer's portability
  // contract. This test locks in that choice: a symlink existing on the source
  // and/or target side (e.g. skills/cli-code-skills -> personal checkout) must neither block
  // installation (scanSymlinks only looks at MANAGED_ENTRIES) nor be overwritten/duplicated.
  assert.ok(!MANAGED_DIRS.includes("skills"), "skills must not become a managed directory");
  const source = await buildFixtureSource();
  const sourceSkillsTarget = await makeTmpDir("pi-agent-source-skills-checkout-");
  await writeFile(join(sourceSkillsTarget, "marker.txt"), "source-checkout\n");
  await mkdir(join(source, "skills"), { recursive: true });
  await symlink(sourceSkillsTarget, join(source, "skills", "cli-code-skills"));

  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  const targetSkillsCheckout = await makeTmpDir("pi-agent-target-skills-checkout-");
  await writeFile(join(targetSkillsCheckout, "marker.txt"), "target-checkout\n");
  await mkdir(join(target, "skills"), { recursive: true });
  await symlink(targetSkillsCheckout, join(target, "skills", "cli-code-skills"));

  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.ok(!result.syncedDirs.includes("skills"), "skills/ must never be synced by the installer");
    // The target-side symlink stays unchanged, not replaced by the source's.
    assert.equal(
      await readFile(join(target, "skills", "cli-code-skills", "marker.txt"), "utf8"),
      "target-checkout\n",
      "the symlink already present on the target side must be preserved as-is (no silent double activation)",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(sourceSkillsTarget, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
    await rm(targetSkillsCheckout, { recursive: true, force: true });
  }
});

test("refuses a target that is a symbolic link", async () => {
  const source = await buildFixtureSource();
  const parent = await makeTmpDir("pi-agent-target-");
  const real = join(parent, "real-elsewhere");
  const link = join(parent, "agent-link");
  await mkdir(real, { recursive: true });
  await symlink(real, link);
  try {
    await assert.rejects(
      runInstall({ sourceRoot: source, target: link, noPackages: true }),
      /symbolic link/,
    );
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(real));
    assert.deepEqual(entries, [], "nothing should have been written through the link");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("refuses source == target", async () => {
  const source = await buildFixtureSource();
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target: source, noPackages: true }), /identical/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("refuses an overlapping source/target", async () => {
  const source = await buildFixtureSource();
  const nested = join(source, "nested-target");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target: nested, noPackages: true }), /overlap/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("a pi install failure for one source reports the failure without blocking resource copy", async () => {
  const source = await buildFixtureSource({ settings: { packages: ["npm:good", "npm:bad"] } });
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  const fakePi = await makeFakePi({ failSource: "npm:bad" });
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: false, env: fakePi.env });
    assert.deepEqual(result.installedPackages, ["npm:good"]);
    assert.equal(result.packageFailures.length, 1);
    assert.equal(result.packageFailures[0].source, "npm:bad");
    assert.ok(await readFile(join(target, "agents", "worker.md"), "utf8"));
    const log = await readFile(fakePi.logPath, "utf8");
    assert.match(log, /install npm:good/);
    assert.match(log, /install npm:bad/);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
    await rm(fakePi.binDir, { recursive: true, force: true });
  }
});

test("default target resolution respects a provided env, never the process's real HOME", async () => {
  const source = await buildFixtureSource();
  const isolatedHome = await makeTmpDir("pi-agent-fake-home-");
  const target = join(isolatedHome, "agent");
  try {
    const result = await runInstall({
      sourceRoot: source,
      noPackages: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: target },
    });
    assert.equal(result.target, target);
    assert.notEqual(result.target, join(require_os_homedir()));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

function require_os_homedir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

test("preserves a file/directory added by the user in a managed directory (never rm(dest))", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(join(target, "extensions", "perso"), { recursive: true });
  await writeFile(join(target, "extensions", "perso", "index.ts"), "export const perso = 1;\n");
  await mkdir(join(target, "agents"), { recursive: true });
  await writeFile(join(target, "agents", "perso.md"), "# perso\n");
  try {
    await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(
      await readFile(join(target, "extensions", "perso", "index.ts"), "utf8"),
      "export const perso = 1;\n",
      "unmanaged personal extension must survive the sync",
    );
    assert.equal(await readFile(join(target, "agents", "perso.md"), "utf8"), "# perso\n");
    assert.ok(
      await readFile(join(target, "extensions", "demo", "index.ts"), "utf8"),
      "the source's managed resource must also be present",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("refuses a symlink nested inside a managed target resource, writes nothing", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  const outside = join(targetParent, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "escape.txt"), "must never be written\n");
  await mkdir(join(target, "extensions"), { recursive: true });
  await symlink(outside, join(target, "extensions", "escaped"));
  try {
    await assert.rejects(
      runInstall({ sourceRoot: source, target, noPackages: true }),
      /symbolic link/,
    );
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(target));
    assert.ok(!entries.includes("settings.json"), "no mutation must have happened before the refusal");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("a missing target settings.json is treated as absent (fresh target, no required ancestor)", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "nested", "agent");
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(result.target, target);
    assert.equal(result.backupDir, null);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("malformed source settings.json: refused before any mutation, target intact", async () => {
  const source = await buildFixtureSource();
  await writeFile(join(source, "settings.json"), "{ this is not JSON");
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
  await writeFile(join(target, "marker.txt"), "pre-existing\n");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /invalid JSON/);
    assert.equal(await readFile(join(target, "settings.json"), "utf8"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    assert.equal(await readFile(join(target, "marker.txt"), "utf8"), "pre-existing\n");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(target));
    assert.deepEqual(entries.sort(), ["marker.txt", "settings.json"], "no backup or copy should have been created");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("malformed target settings.json: refused before any mutation, managed target resources intact", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(join(target, "extensions"), { recursive: true });
  await writeFile(join(target, "extensions", "perso.ts"), "export const x = 1;\n");
  await writeFile(join(target, "settings.json"), "{ not valid json");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /invalid JSON/);
    assert.equal(await readFile(join(target, "extensions", "perso.ts"), "utf8"), "export const x = 1;\n");
    const backups = (await import("node:fs/promises").then((fs) => fs.readdir(targetParent))).filter((n) => n.includes(".backup-"));
    assert.deepEqual(backups, [], "no backup should be created before validation succeeds");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("filtered package resources survive install and replace the unfiltered package", async () => {
  const entry = { source: "npm:@ian-pascoe/pi-lsp@0.4.4", extensions: [] };
  const source = await buildFixtureSource({ settings: { packages: [entry] } });
  const parent = await makeTmpDir("pi-filtered-package-");
  const target = join(parent, "agent");
  const fakePi = await makeFakePi();
  try {
    await mkdir(target);
    await writeFile(join(target, "settings.json"), JSON.stringify({ packages: [entry.source] }));
    const result = await runInstall({ sourceRoot: source, target, env: fakePi.env });
    assert.deepEqual(result.packageFailures, []);
    assert.deepEqual((await readJson(join(target, "settings.json"))).packages, [entry]);
    assert.match(await readFile(fakePi.logPath, "utf8"), /install npm:@ian-pascoe\/pi-lsp@0.4.4/);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(fakePi.binDir, { recursive: true, force: true });
  }
});

test("packageIdentity: distinguishes version/sha from the rest, preserves npm scopes", async () => {
  const { packageIdentity } = await import("../scripts/install.mjs");
  assert.equal(packageIdentity("npm:pi-simplify@0.2.3"), "npm:pi-simplify");
  assert.equal(
    packageIdentity("git:github.com/DietrichGebert/ponytail@e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156"),
    "git:github.com/DietrichGebert/ponytail",
  );
  assert.equal(packageIdentity("npm:@ian-pascoe/pi-lsp@0.4.4"), "npm:@ian-pascoe/pi-lsp");
  assert.equal(packageIdentity("npm:@scope/no-version"), "npm:@scope/no-version");
});
