import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findPiPackageJson } from "../lib/resolve-pi.mjs";
import { patchProjectTrust, TRUST_TARGETS_BY_VERSION, transformTrust } from "../scripts/patch-project-trust.mjs";
import { patchPaste } from "../scripts/patch-paste.mjs";
import { TARGETS_BY_VERSION } from "../patches/paste-keepalive.mjs";
import { renderLauncher, runCommand, selfUpdateOptions, updateRuntime } from "../scripts/update-runtime.mjs";

const installedManifest = findPiPackageJson();
assert.ok(installedManifest, "Installed Pi SDK is required");
const installed = JSON.parse(await readFile(installedManifest, "utf8"));
const packageSuffix = "node_modules/@earendil-works/pi-coding-agent/package.json";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-update-test-"));
  const logDirs = new Set();
  t.after(async () => {
    for (const path of [root, ...logDirs]) await rm(path, { recursive: true, force: true });
  });
  const packageJson = join(root, "active", packageSuffix), launcher = join(root, "pi");
  const packageRoot = dirname(packageJson);
  await mkdir(join(packageRoot, "dist/bundle"), { recursive: true });
  await writeFile(packageJson, JSON.stringify({ name: installed.name, version: installed.version }));
  await writeFile(join(packageRoot, "dist/bundle/cli.js"), 'console.log(JSON.stringify({args:process.argv.slice(2),manifest:process.env.PI_PACKAGE_JSON,cwd:process.cwd()})); process.exitCode=23;\n');
  await writeFile(launcher, renderLauncher(packageJson), { mode: 0o700 });
  return { root, packageJson, launcher, packageRoot, logDirs };
}

async function copyArtifacts(packageRoot) {
  const installedRoot = dirname(installedManifest);
  for (const target of TRUST_TARGETS_BY_VERSION[installed.version]) {
    const dest = join(packageRoot, target.path);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(installedRoot, target.path), dest);
  }
  for (const target of TARGETS_BY_VERSION[installed.version]) {
    const dependency = target.id === "pi-tui-dependency-terminal";
    const sourceRoot = dependency ? join(dirname(installedRoot), "pi-tui") : installedRoot;
    const destRoot = dependency ? join(dirname(packageRoot), "pi-tui") : packageRoot;
    await mkdir(dirname(join(destRoot, target.relativePath)), { recursive: true });
    await cp(join(sourceRoot, target.relativePath), join(destRoot, target.relativePath));
    if (dependency) await cp(join(sourceRoot, "package.json"), join(destRoot, "package.json"));
  }
  await patchProjectTrust(packageRoot);
  await patchPaste(packageRoot);
}

function fakeRun(f, { latest = installed.version, fail, onVerify } = {}) {
  const commands = [];
  const run = async (command, args, options) => {
    f.logDirs.add(dirname(options.log));
    commands.push({ command, args, options });
    if (args[0] === "view") return JSON.stringify(latest);
    if (args[0] === "install") {
      if (fail === "install") throw new Error("fixture install failure");
      const prefix = args[args.indexOf("--prefix") + 1];
      if (!prefix.endsWith("paste-fixture")) {
        await cp(join(f.root, "active/node_modules"), join(prefix, "node_modules"), { recursive: true });
        await copyArtifacts(join(prefix, "node_modules/@earendil-works/pi-coding-agent"));
        if (fail === "patch") await writeFile(join(prefix, "node_modules/@earendil-works/pi-coding-agent", TRUST_TARGETS_BY_VERSION[installed.version][0].path), "tampered\n");
      }
    }
    if (args[0] === "run") {
      assert.deepEqual(args, ["run", "verify:integration"]);
      assert.ok(options.env.PI_PASTE_PACKAGE_JSON);
      assert.equal(options.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
      assert.ok(options.env.PATH.startsWith(dirname(options.log)));
      if (onVerify) await onVerify(options);
      if (fail === "verify") throw new Error("fixture verification failure");
    }
    return "";
  };
  return { run, commands };
}

test("self-update routing preserves Pi commands, help and invalid-argument handling", () => {
  for (const args of [[], ["--self"], ["self"], ["pi"], ["--force"], ["self", "--self"]]) {
    assert.equal(selfUpdateOptions(["update", ...args]).extensions, false);
  }
  for (const args of [["--all"], ["--self", "--extensions"], ["self", "--extensions"]]) {
    assert.equal(selfUpdateOptions(["update", ...args]).extensions, true);
  }
  assert.deepEqual(selfUpdateOptions(["update", "--all", "--force", "--no-approve"]).extensionArgs, ["update", "--extensions", "--force", "--no-approve"]);
  for (const args of [["--extensions"], ["--models"], ["--extension", "npm:x"], ["npm:x"], ["--help"], ["--self", "--models"], ["--all", "--self"], ["--all", "self"], ["--wat"], ["self", "pi"], ["-l"]]) {
    assert.equal(selfUpdateOptions(["update", ...args]), undefined, args.join(" "));
  }
});

test("generated launcher forwards arguments, manifest and native exit status through quoted paths", async t => {
  const f = await fixture(t);
  const strange = join(f.root, "a 'quote' $(touch injected) `literal`");
  await mkdir(strange);
  const manifest = join(strange, packageSuffix);
  await cp(join(f.root, "active"), strange, { recursive: true });
  await writeFile(f.launcher, renderLauncher(manifest));
  for (const args of [["--version", "a b"], ["update", "--extensions"], ["update", "--models"], ["update", "--self", "--help"], ["update", "--all", "--self"]]) {
    const output = join(f.root, "output.log"), fd = openSync(output, "w");
    let result;
    try { result = spawnSync(f.launcher, args, { cwd: f.root, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    assert.ifError(result.error);
    const stdout = readFileSync(output, "utf8");
    assert.equal(result.status, 23, stdout);
    assert.deepEqual(JSON.parse(stdout), { args, manifest, cwd: f.root });
  }
  assert.equal((await readdir(f.root)).includes("injected"), false);
  assert.throws(() => renderLauncher("/line\nbreak/package.json"), /line breaks/);
});

test("unsupported, malformed and older registry versions leave the launcher and runtime untouched", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  for (const latest of ["9999.0.0", "bad;command", "0.0.1"]) {
    const fake = fakeRun(f, { latest });
    await assert.rejects(updateRuntime(f, fake), /validated trust\/paste|stable Pi version|refusing to downgrade/);
    assert.equal(fake.commands.length, 1);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    assert.deepEqual((await readdir(f.root)).sort(), ["active", "pi"]);
  }
});

test("installation and each failed update stage preserve the active runtime and release the lock", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  for (const fail of ["install", "patch", "verify"]) {
    const fake = fakeRun(f, { fail });
    await assert.rejects(updateRuntime({ ...f, force: true }, fake), /fixture .* failure|Unknown trust patch/);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    await assert.rejects(lstat(`${f.launcher}.update-lock`), { code: "ENOENT" });
    assert.ok(!(await readdir(f.root)).some(name => name.startsWith("pi.backup-")));
  }
  // A legacy launcher is not replaced when its native integration gate fails.
  await copyArtifacts(f.packageRoot);
  await writeFile(f.launcher, "#!/bin/sh\nexit 7\n");
  await assert.rejects(updateRuntime({ ...f, installLauncher: true }, fakeRun(f, { fail: "verify" })), /verification failure/);
  assert.equal(await readFile(f.launcher, "utf8"), "#!/bin/sh\nexit 7\n");
});

test("successful update checks both patches and the native gate before switching, with a backup", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  let validatedManifest;
  const fake = fakeRun(f, { onVerify: async ({ env }) => {
    validatedManifest = env.PI_PACKAGE_JSON;
    assert.notEqual(validatedManifest, f.packageJson);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    assert.match(await readFile(join(dirname(validatedManifest), TRUST_TARGETS_BY_VERSION[installed.version][0].path), "utf8"), /honor personal trust handlers/);
  } });
  const result = await updateRuntime({ ...f, force: true }, fake);
  assert.equal(result.manifest, validatedManifest);
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(validatedManifest));
  assert.equal(await readFile(result.backup, "utf8"), before);
  assert.equal(JSON.parse(await readFile(f.packageJson, "utf8")).version, installed.version);
  assert.ok((await lstat(f.launcher)).mode & 0o100);
});

test("up-to-date runtime is validated without installation or activation; missing patches are refused without repair", async t => {
  const f = await fixture(t);
  await copyArtifacts(f.packageRoot);
  const fake = fakeRun(f);
  const result = await updateRuntime(f, fake);
  assert.equal(result.manifest, f.packageJson);
  assert.equal(fake.commands.length, 1);
  const target = TRUST_TARGETS_BY_VERSION[installed.version][0];
  const path = join(f.packageRoot, target.path);
  const pristine = transformTrust(await readFile(path, "utf8"), target, true);
  await writeFile(path, pristine);
  await assert.rejects(updateRuntime(f, fake), /patch is missing/);
  assert.equal(await readFile(path, "utf8"), pristine);
});

test("initial activation backs up the legacy launcher after validation and detects later artifact changes", async t => {
  const f = await fixture(t);
  await copyArtifacts(f.packageRoot);
  const legacy = "#!/bin/sh\nexit 7\n";
  await writeFile(f.launcher, legacy);
  const fake = fakeRun(f, { onVerify: async () => assert.equal(await readFile(f.launcher, "utf8"), legacy) });
  const result = await updateRuntime({ ...f, installLauncher: true }, fake);
  assert.equal(result.manifest, f.packageJson);
  assert.equal(await readFile(result.backup, "utf8"), legacy);
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(f.packageJson));

  const before = await readFile(f.launcher, "utf8");
  const tamper = fakeRun(f, { onVerify: async ({ env }) => {
    const target = TRUST_TARGETS_BY_VERSION[installed.version][0];
    await writeFile(join(dirname(env.PI_PACKAGE_JSON), target.path), "changed during gate\n");
  } });
  await assert.rejects(updateRuntime({ ...f, force: true }, tamper), /Unknown trust patch/);
  assert.equal(await readFile(f.launcher, "utf8"), before);
});

test("paste check-only mode refuses missing patches without writing to the active runtime", async t => {
  const f = await fixture(t);
  await copyArtifacts(f.packageRoot);
  const target = TARGETS_BY_VERSION[installed.version].find(target => target.id === "bundled-cli-chunk");
  const path = join(f.packageRoot, target.relativePath);
  let pristine = await readFile(path, "utf8");
  for (const { search, replace } of [...target.replacements].reverse()) pristine = pristine.replace(replace, search);
  await writeFile(path, pristine);
  await assert.rejects(updateRuntime(f, fakeRun(f)), /Paste patch is missing/);
  assert.equal(await readFile(path, "utf8"), pristine);
});

test("concurrent updater, changed launcher and symlink launcher are refused", async t => {
  const f = await fixture(t);
  const lock = `${f.launcher}.update-lock`;
  await mkdir(lock);
  await assert.rejects(updateRuntime(f, fakeRun(f)), /Another update/);
  await rm(lock, { recursive: true });
  const fake = fakeRun(f, { onVerify: () => writeFile(f.launcher, "personal edit\n") });
  await assert.rejects(updateRuntime({ ...f, force: true }, fake), /changed during validation/);
  assert.equal(await readFile(f.launcher, "utf8"), "personal edit\n");
  await assert.rejects(updateRuntime(f, fakeRun(f)), /no longer selects/);
  const link = join(f.root, "symlink");
  await symlink(f.launcher, link);
  await assert.rejects(updateRuntime({ ...f, launcher: link }, fakeRun(f)), /regular file/);
});

test("command failures retain the actual exit status and command log", async t => {
  const f = await fixture(t), log = join(f.root, "command.log");
  assert.throws(() => runCommand(process.execPath, ["-e", 'console.error("deliberate failure"); process.exit(37)'], { log }), error => error.exitCode === 37);
  assert.match(await readFile(log, "utf8"), /deliberate failure/);
});

test("real update CLI keeps npm warnings out of metadata and forwards --all extension failures", async t => {
  const f = await fixture(t);
  await copyArtifacts(f.packageRoot);
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node\nconsole.error("registry warning"); console.log(JSON.stringify(${JSON.stringify(installed.version)}));\n`, { mode: 0o700 });
  const output = join(f.root, "output.log"), fd = openSync(output, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/update-runtime.mjs", import.meta.url)),
      "--launcher", f.launcher, "--package-json", f.packageJson, "--", "update", "--all", "--no-approve"], {
      cwd: f.root, env: { ...process.env, TMPDIR: f.root, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", fd, fd],
    });
  } finally { closeSync(fd); }
  assert.ifError(result.error);
  const stdout = readFileSync(output, "utf8");
  assert.equal(result.status, 23, stdout);
  assert.match(stdout, /already up to date/);
  assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), {
    args: ["update", "--extensions", "--no-approve"], manifest: f.packageJson, cwd: f.root,
  });
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(f.packageJson));
});
