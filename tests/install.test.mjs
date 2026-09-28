import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInstall, MANAGED_DIRS } from "../scripts/install.mjs";
import { buildFixtureSource, makeFakePi, makeTmpDir } from "./fixtures/build.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("installation fraîche copie les ressources gérées et écrit settings.json de la source", async () => {
  const source = await buildFixtureSource();
  const target = join(await makeTmpDir("pi-agent-target-"), "agent");
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(result.target, target);
    assert.equal(result.backupDir, null, "rien à sauvegarder sur une cible neuve");
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

test("réinstallation conserve les préférences existantes, remplace les paquets gérés par identité, préserve paquets personnels et fichiers hors périmètre", async () => {
  const source = await buildFixtureSource({ settings: { defaultProvider: "anthropic", packages: ["npm:pkg-a@2.0.0"] } });
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "settings.json"),
    `${JSON.stringify({ theme: "dark", packages: ["npm:pkg-a@1.0.0", "npm:perso-pkg"] }, null, 2)}\n`,
  );
  await writeFile(join(target, "keybindings.json"), "{}\n");
  await writeFile(join(target, "notes-custom.txt"), "à préserver\n");
  try {
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.ok(result.backupDir, "une sauvegarde doit être créée quand des ressources existent déjà");
    const backupSettings = await readJson(join(result.backupDir, "settings.json"));
    assert.deepEqual(backupSettings.packages, ["npm:pkg-a@1.0.0", "npm:perso-pkg"], "la sauvegarde contient l'ancien état");

    const settings = await readJson(join(target, "settings.json"));
    assert.equal(settings.theme, "dark", "préférence existante conservée");
    assert.deepEqual(
      settings.packages,
      ["npm:pkg-a@2.0.0", "npm:perso-pkg"],
      "paquet géré (même identité) remplacé par la version de la source, paquet personnel préservé",
    );
    assert.equal(settings.defaultProvider, "anthropic", "clé nouvelle de la source ajoutée");
    assert.deepEqual(result.packages, ["npm:pkg-a@2.0.0"], "seuls les paquets gérés de la source sont proposés à l'installation");

    assert.equal(await readFile(join(target, "notes-custom.txt"), "utf8"), "à préserver\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("secrets et état privés jamais touchés par l'installation", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(join(target, "sessions"), { recursive: true });
  await writeFile(join(target, "auth.json"), '{"secret":"ne-pas-toucher"}\n');
  await writeFile(join(target, "models-store.json"), "{}\n");
  await writeFile(join(target, "trust.json"), "{}\n");
  await writeFile(join(target, "sessions", "s1.jsonl"), "{}\n");
  try {
    await runInstall({ sourceRoot: source, target, noPackages: true });
    assert.equal(await readFile(join(target, "auth.json"), "utf8"), '{"secret":"ne-pas-toucher"}\n');
    assert.equal(await readFile(join(target, "models-store.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(target, "trust.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(target, "sessions", "s1.jsonl"), "utf8"), "{}\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("skills/ n'est pas géré : un lien symbolique live (ex. checkout cli-code-skills) survit à l'installation sans double activation", async () => {
  // `skills` est volontairement absent de MANAGED_DIRS/MANAGED_ENTRIES : Pi le scanne
  // nativement (~/.pi/agent/skills), il ne fait pas partie du contrat de portabilité de
  // cet installeur. Ce test verrouille ce choix : un lien symbolique existant côté source
  // et/ou côté cible (ex. skills/cli-code-skills -> checkout personnel) ne doit ni bloquer
  // l'installation (scanSymlinks ne regarde que MANAGED_ENTRIES) ni être écrasé/dupliqué.
  assert.ok(!MANAGED_DIRS.includes("skills"), "skills ne doit pas devenir un répertoire géré");
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
    assert.ok(!result.syncedDirs.includes("skills"), "skills/ ne doit jamais être synchronisé par l'installeur");
    // Le lien symbolique côté cible reste inchangé, pas remplacé par celui de la source.
    assert.equal(
      await readFile(join(target, "skills", "cli-code-skills", "marker.txt"), "utf8"),
      "target-checkout\n",
      "le lien symbolique déjà présent côté cible doit être préservé tel quel (pas de double activation silencieuse)",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(sourceSkillsTarget, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
    await rm(targetSkillsCheckout, { recursive: true, force: true });
  }
});

test("refuse une cible qui est un lien symbolique", async () => {
  const source = await buildFixtureSource();
  const parent = await makeTmpDir("pi-agent-target-");
  const real = join(parent, "real-elsewhere");
  const link = join(parent, "agent-link");
  await mkdir(real, { recursive: true });
  await symlink(real, link);
  try {
    await assert.rejects(
      runInstall({ sourceRoot: source, target: link, noPackages: true }),
      /lien symbolique/,
    );
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(real));
    assert.deepEqual(entries, [], "rien n'a dû être écrit à travers le lien");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("refuse source == cible", async () => {
  const source = await buildFixtureSource();
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target: source, noPackages: true }), /identique/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("refuse un chevauchement source/cible", async () => {
  const source = await buildFixtureSource();
  const nested = join(source, "nested-target");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target: nested, noPackages: true }), /chevauchent/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("un échec pi install pour une source rapporte l'échec sans bloquer la copie des ressources", async () => {
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

test("la résolution de cible par défaut respecte un env fourni, jamais le HOME réel du process", async () => {
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

test("préserve un fichier/dossier ajouté par l'utilisateur dans un répertoire géré (jamais rm(dest))", async () => {
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
      "extension personnelle non gérée doit survivre à la synchronisation",
    );
    assert.equal(await readFile(join(target, "agents", "perso.md"), "utf8"), "# perso\n");
    assert.ok(
      await readFile(join(target, "extensions", "demo", "index.ts"), "utf8"),
      "la ressource gérée de la source doit aussi être présente",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("refuse un lien symbolique imbriqué dans une ressource gérée de la cible, sans rien écrire", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  const outside = join(targetParent, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "escape.txt"), "ne doit jamais être écrit\n");
  await mkdir(join(target, "extensions"), { recursive: true });
  await symlink(outside, join(target, "extensions", "escaped"));
  try {
    await assert.rejects(
      runInstall({ sourceRoot: source, target, noPackages: true }),
      /lien.*symbolique/,
    );
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(target));
    assert.ok(!entries.includes("settings.json"), "aucune mutation ne doit avoir eu lieu avant le refus");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("un settings.json cible manquant est traité comme absent (target neuve, pas d'ancêtre requis)", async () => {
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

test("settings.json source malformé : refus avant toute mutation, cible intacte", async () => {
  const source = await buildFixtureSource();
  await writeFile(join(source, "settings.json"), "{ ceci n'est pas du JSON");
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
  await writeFile(join(target, "marker.txt"), "préexistant\n");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /JSON invalide/);
    assert.equal(await readFile(join(target, "settings.json"), "utf8"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    assert.equal(await readFile(join(target, "marker.txt"), "utf8"), "préexistant\n");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(target));
    assert.deepEqual(entries.sort(), ["marker.txt", "settings.json"], "aucune sauvegarde ni copie ne doit avoir été créée");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("settings.json cible malformé : refus avant toute mutation, ressources gérées cible intactes", async () => {
  const source = await buildFixtureSource();
  const targetParent = await makeTmpDir("pi-agent-target-");
  const target = join(targetParent, "agent");
  await mkdir(join(target, "extensions"), { recursive: true });
  await writeFile(join(target, "extensions", "perso.ts"), "export const x = 1;\n");
  await writeFile(join(target, "settings.json"), "{ pas du json valide");
  try {
    await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /JSON invalide/);
    assert.equal(await readFile(join(target, "extensions", "perso.ts"), "utf8"), "export const x = 1;\n");
    const backups = (await import("node:fs/promises").then((fs) => fs.readdir(targetParent))).filter((n) => n.includes(".backup-"));
    assert.deepEqual(backups, [], "pas de sauvegarde créée avant que la validation ait réussi");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("packageIdentity : distingue version/sha du reste, préserve les scopes npm", async () => {
  const { packageIdentity } = await import("../scripts/install.mjs");
  assert.equal(packageIdentity("npm:pi-simplify@0.2.3"), "npm:pi-simplify");
  assert.equal(
    packageIdentity("git:github.com/DietrichGebert/ponytail@e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156"),
    "git:github.com/DietrichGebert/ponytail",
  );
  assert.equal(packageIdentity("npm:@ian-pascoe/pi-lsp@0.4.4"), "npm:@ian-pascoe/pi-lsp");
  assert.equal(packageIdentity("npm:@scope/no-version"), "npm:@scope/no-version");
});
