import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  configureGates,
  parseArgs,
  parseRequiredCommands,
  policyKey,
} from "../scripts/configure-gates.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("chemin heureux : écrit root réel + required, mode 0600, dossiers 0700", async () => {
  const project = await makeTmpDir("pi-cg-project-");
  const homeDir = await makeTmpDir("pi-cg-home-");
  try {
    const realProject = await realpath(project);
    const result = await configureGates({
      project,
      commandsJson: '[["npm","run","check"]]',
      homeDir,
    });
    assert.equal(result.root, realProject);
    assert.equal(result.key, policyKey(realProject));
    assert.equal(result.path, join(homeDir, ".config", "pi-orchestrate", "projects", `${result.key}.json`));

    const raw = await readFile(result.path, "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.root, realProject);
    assert.deepEqual(data.required, [["npm", "run", "check"]]);

    const fileStat = await lstat(result.path);
    assert.equal(fileStat.mode & 0o777, 0o600);
    const dirStat = await lstat(join(homeDir, ".config", "pi-orchestrate", "projects"));
    assert.equal(dirStat.mode & 0o777, 0o700);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("--commands JSON invalide est refusé", () => {
  assert.throws(() => parseRequiredCommands("not json"), /JSON valide/);
});

test("--commands schéma invalide est refusé : pas un tableau", async () => {
  assert.throws(() => parseRequiredCommands('{"a":1}'), /tableau JSON non vide/);
});

test("--commands schéma invalide est refusé : tableau vide", async () => {
  assert.throws(() => parseRequiredCommands("[]"), /tableau JSON non vide/);
});

test("--commands schéma invalide est refusé : argv vide", async () => {
  assert.throws(() => parseRequiredCommands("[[]]"), /tableau non vide de chaînes/);
});

test("--commands schéma invalide est refusé : chaîne vide dans argv", async () => {
  assert.throws(() => parseRequiredCommands('[["npm",""]]'), /tableau non vide de chaînes/);
});

test("--commands schéma invalide est refusé : élément non-tableau", async () => {
  assert.throws(() => parseRequiredCommands('["npm"]'), /tableau non vide de chaînes/);
});

test("--commands schéma invalide est refusé : élément non-chaîne", async () => {
  assert.throws(() => parseRequiredCommands("[[1,2]]"), /tableau non vide de chaînes/);
});

test("refuse d'écraser une politique existante, fichier inchangé", async () => {
  const project = await makeTmpDir("pi-cg-project-");
  const homeDir = await makeTmpDir("pi-cg-home-");
  try {
    const first = await configureGates({
      project,
      commandsJson: '[["npm","test"]]',
      homeDir,
    });
    const before = await readFile(first.path, "utf8");

    await assert.rejects(
      () =>
        configureGates({
          project,
          commandsJson: '[["npm","run","other"]]',
          homeDir,
        }),
      /refus d'écraser/,
    );

    const after = await readFile(first.path, "utf8");
    assert.equal(after, before);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("refuse un symlink à l'emplacement de la politique, rien n'est écrit à travers lui", async () => {
  const project = await makeTmpDir("pi-cg-project-");
  const homeDir = await makeTmpDir("pi-cg-home-");
  const elsewhere = await makeTmpDir("pi-cg-elsewhere-");
  try {
    const key = policyKey(await realpath(project));
    const projectsDir = join(homeDir, ".config", "pi-orchestrate", "projects");
    await mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const target = join(elsewhere, "escaped.json");
    await symlink(target, join(projectsDir, `${key}.json`));

    await assert.rejects(
      () =>
        configureGates({
          project,
          commandsJson: '[["npm","test"]]',
          homeDir,
        }),
      /lien symbolique|refus d'écraser/,
    );

    await assert.rejects(() => readFile(target, "utf8"));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("refuse un symlink sur un dossier parent géré (.config/pi-orchestrate)", async () => {
  const project = await makeTmpDir("pi-cg-project-");
  const homeDir = await makeTmpDir("pi-cg-home-");
  const elsewhere = await makeTmpDir("pi-cg-elsewhere-");
  try {
    await mkdir(join(homeDir, ".config"), { recursive: true, mode: 0o700 });
    await mkdir(join(elsewhere, "pi-orchestrate"), { recursive: true, mode: 0o700 });
    await symlink(join(elsewhere, "pi-orchestrate"), join(homeDir, ".config", "pi-orchestrate"));

    await assert.rejects(
      () =>
        configureGates({
          project,
          commandsJson: '[["npm","test"]]',
          homeDir,
        }),
      /lien symbolique/,
    );

    const escapedEntries = await lstat(join(elsewhere, "pi-orchestrate")).then(
      () => true,
      () => false,
    );
    assert.ok(escapedEntries);
    const leaked = await lstat(join(elsewhere, "pi-orchestrate", "projects")).then(
      () => true,
      () => false,
    );
    assert.equal(leaked, false, "aucun dossier ne doit avoir été créé à travers le symlink");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("--project inexistant est refusé", async () => {
  const homeDir = await makeTmpDir("pi-cg-home-");
  try {
    await assert.rejects(
      () =>
        configureGates({
          project: join(homeDir, "does-not-exist"),
          commandsJson: '[["npm","test"]]',
          homeDir,
        }),
      /introuvable/,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("--project vide est refusé", async () => {
  await assert.rejects(
    () => configureGates({ project: "", commandsJson: '[["npm","test"]]', homeDir: "/tmp" }),
    /--project est requis/,
  );
});

test("racine réelle = realpath (traverse un symlink de projet)", async () => {
  const tmpProject = await makeTmpDir("pi-cg-real-");
  const realProject = await realpath(tmpProject);
  const homeDir = await makeTmpDir("pi-cg-home-");
  const wrapper = await makeTmpDir("pi-cg-wrapper-");
  const linkPath = join(wrapper, "alias");
  try {
    await symlink(tmpProject, linkPath);
    const result = await configureGates({
      project: linkPath,
      commandsJson: '[["npm","test"]]',
      homeDir,
    });
    assert.equal(result.root, realProject);
    assert.equal(result.key, policyKey(realProject));
  } finally {
    await rm(realProject, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(wrapper, { recursive: true, force: true });
  }
});

test("parseArgs lit --project et --commands, refuse un argument inconnu", () => {
  const args = parseArgs(["--project", "/x", "--commands", "[]"]);
  assert.equal(args.project, "/x");
  assert.equal(args.commands, "[]");
  assert.throws(() => parseArgs(["--bogus"]), /argument inconnu/);
});

test("CLI bout-en-bout : succès puis refus d'écrasement", async () => {
  const { spawnSync } = await import("node:child_process");
  const project = await makeTmpDir("pi-cg-project-");
  const homeDir = await makeTmpDir("pi-cg-home-");
  const scriptPath = new URL("../scripts/configure-gates.mjs", import.meta.url);
  try {
    const run = (extraArgs) =>
      spawnSync(process.execPath, [scriptPath.pathname, ...extraArgs], {
        env: { ...process.env, HOME: homeDir },
        encoding: "utf8",
      });

    const first = run(["--project", project, "--commands", '[["npm","run","check"]]']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Politique écrite/);

    const second = run(["--project", project, "--commands", '[["npm","test"]]']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refus d'écraser/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
