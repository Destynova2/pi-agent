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

test("happy path: writes real root + required, mode 0600, dirs 0700", async () => {
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

test("--commands invalid JSON is refused", () => {
  assert.throws(() => parseRequiredCommands("not json"), /valid JSON/);
});

test("--commands invalid schema is refused: not an array", async () => {
  assert.throws(() => parseRequiredCommands('{"a":1}'), /non-empty JSON array/);
});

test("--commands invalid schema is refused: empty array", async () => {
  assert.throws(() => parseRequiredCommands("[]"), /non-empty JSON array/);
});

test("--commands invalid schema is refused: empty argv", async () => {
  assert.throws(() => parseRequiredCommands("[[]]"), /non-empty array of non-empty strings/);
});

test("--commands invalid schema is refused: empty string in argv", async () => {
  assert.throws(() => parseRequiredCommands('[["npm",""]]'), /non-empty array of non-empty strings/);
});

test("--commands invalid schema is refused: non-array element", async () => {
  assert.throws(() => parseRequiredCommands('["npm"]'), /non-empty array of non-empty strings/);
});

test("--commands invalid schema is refused: non-string element", async () => {
  assert.throws(() => parseRequiredCommands("[[1,2]]"), /non-empty array of non-empty strings/);
});

test("refuses to overwrite an existing policy, file unchanged", async () => {
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
      /refuse to overwrite/,
    );

    const after = await readFile(first.path, "utf8");
    assert.equal(after, before);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("refuses a symlink at the policy location, nothing is written through it", async () => {
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
      /symbolic link|refuse to overwrite/,
    );

    await assert.rejects(() => readFile(target, "utf8"));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("refuses a symlink on a managed parent directory (.config/pi-orchestrate)", async () => {
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
      /symbolic link/,
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
    assert.equal(leaked, false, "no directory should have been created through the symlink");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("--project nonexistent is refused", async () => {
  const homeDir = await makeTmpDir("pi-cg-home-");
  try {
    await assert.rejects(
      () =>
        configureGates({
          project: join(homeDir, "does-not-exist"),
          commandsJson: '[["npm","test"]]',
          homeDir,
        }),
      /not found/,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("--project empty is refused", async () => {
  await assert.rejects(
    () => configureGates({ project: "", commandsJson: '[["npm","test"]]', homeDir: "/tmp" }),
    /--project is required/,
  );
});

test("real root = realpath (traverses a project symlink)", async () => {
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

test("parseArgs reads --project and --commands, refuses an unknown argument", () => {
  const args = parseArgs(["--project", "/x", "--commands", "[]"]);
  assert.equal(args.project, "/x");
  assert.equal(args.commands, "[]");
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("end-to-end CLI: success then refused overwrite", async () => {
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
    assert.match(first.stdout, /Policy written/);

    const second = run(["--project", project, "--commands", '[["npm","test"]]']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refuse to overwrite/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
