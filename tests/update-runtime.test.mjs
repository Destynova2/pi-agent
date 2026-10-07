import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync, readFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiPackageJson } from "../lib/resolve-pi.mjs";
import { confinedArgs, prepareUpdater, renderLauncher, runCommand, selfUpdateOptions, updateRuntime } from "../scripts/update-runtime.mjs";

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
  const agentDir = join(root, "agent");
  await mkdir(join(packageRoot, "dist/bundle"), { recursive: true });
  await writeFile(packageJson, JSON.stringify({ name: installed.name, version: installed.version }));
  await writeFile(join(packageRoot, "dist/bundle/cli.js"), 'console.log(JSON.stringify({args:process.argv.slice(2),manifest:process.env.PI_PACKAGE_JSON,cwd:process.cwd()})); process.exitCode=23;\n');
  const updater = await prepareUpdater(agentDir);
  await writeFile(launcher, renderLauncher(packageJson, { agentDir }), { mode: 0o700 });
  // Exercise the launcher's bound default independently of the gate's staged agent.
  // Explicit override behavior has its own test below.
  const env = { ...process.env };
  delete env.PI_CODING_AGENT_DIR;
  return { root, packageJson, launcher, packageRoot, logDirs, agentDir, updater, env };
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
      await cp(join(f.root, "active/node_modules"), join(prefix, "node_modules"), { recursive: true });
      await writeFile(join(prefix, packageSuffix), JSON.stringify({ name: installed.name, version: fail === "manifest" ? "0.0.1" : latest }));
    }
    if (args[0] === "run") {
      assert.deepEqual(args, ["run", "verify:integration"]);
      assert.equal(options.env.PI_CODING_AGENT_DIR, f.agentDir);
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
  await writeFile(f.launcher, renderLauncher(manifest, f));
  for (const args of [["--version", "a b"], ["update", "--extensions"], ["update", "--models"], ["update", "--self", "--help"], ["update", "--all", "--self"]]) {
    const output = join(f.root, "output.log"), fd = openSync(output, "w");
    let result;
    try { result = spawnSync(f.launcher, args, { cwd: f.root, env: f.env, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    assert.ifError(result.error);
    const stdout = readFileSync(output, "utf8");
    assert.equal(result.status, 23, stdout);
    assert.deepEqual(JSON.parse(stdout), { args: confinedArgs(args), manifest, cwd: f.root });
  }
  assert.equal((await readdir(f.root)).includes("injected"), false);
  assert.throws(() => renderLauncher("/line\nbreak/package.json"), /line breaks/);
});

test("unsupported, malformed and older registry versions leave the launcher and runtime untouched", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  for (const latest of ["9999.0.0", "bad;command", "0.0.1"]) {
    const fake = fakeRun(f, { latest });
    await assert.rejects(updateRuntime(f, fake), /supported 1.x|stable Pi version|refusing to downgrade/);
    assert.equal(fake.commands.length, 1);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    assert.deepEqual((await readdir(f.root)).sort(), ["active", "agent", "pi"]);
  }
});

test("installation and each failed update stage preserve the active runtime and release the lock", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  for (const fail of ["install", "manifest", "verify"]) {
    const fake = fakeRun(f, { fail });
    await assert.rejects(updateRuntime({ ...f, force: true }, fake), /fixture .* failure|Installed Pi/);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    await assert.rejects(lstat(`${f.launcher}.update-lock`), { code: "ENOENT" });
    assert.ok(!(await readdir(f.root)).some(name => name.startsWith("pi.backup-")));
  }
  // A legacy launcher is not replaced when its native integration gate fails.
  await writeFile(f.launcher, "#!/bin/sh\nexit 7\n");
  await assert.rejects(updateRuntime({ ...f, installLauncher: true }, fakeRun(f, { fail: "verify" })), /verification failure/);
  assert.equal(await readFile(f.launcher, "utf8"), "#!/bin/sh\nexit 7\n");
});

test("successful update validates an untouched runtime before switching, with a backup", async t => {
  const f = await fixture(t), before = await readFile(f.launcher, "utf8");
  let validatedManifest;
  const fake = fakeRun(f, { onVerify: async ({ env }) => {
    validatedManifest = env.PI_PACKAGE_JSON;
    assert.notEqual(validatedManifest, f.packageJson);
    assert.equal(await readFile(f.launcher, "utf8"), before);
    assert.equal(await readFile(join(dirname(validatedManifest), "dist/bundle/cli.js"), "utf8"), await readFile(join(f.packageRoot, "dist/bundle/cli.js"), "utf8"));
  } });
  const result = await updateRuntime({ ...f, force: true }, fake);
  assert.equal(result.manifest, validatedManifest);
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(validatedManifest, f));
  assert.equal(await readFile(result.backup, "utf8"), before);
  assert.equal(JSON.parse(await readFile(f.packageJson, "utf8")).version, installed.version);
  assert.ok((await lstat(f.launcher)).mode & 0o100);
});

test("up-to-date runtime requires no patch metadata or artifact writes", async t => {
  const f = await fixture(t), before = await readFile(f.packageJson, "utf8");
  const fake = fakeRun(f);
  const result = await updateRuntime(f, fake);
  assert.equal(result.manifest, f.packageJson);
  assert.equal(fake.commands.length, 1);
  assert.equal(await readFile(f.packageJson, "utf8"), before);
});

test("initial activation backs up the legacy launcher after validation and detects later artifact changes", async t => {
  const f = await fixture(t);
  const legacy = "#!/bin/sh\nexit 7\n";
  await writeFile(f.launcher, legacy);
  const fake = fakeRun(f, { onVerify: async () => assert.equal(await readFile(f.launcher, "utf8"), legacy) });
  const result = await updateRuntime({ ...f, installLauncher: true }, fake);
  assert.equal(result.manifest, f.packageJson);
  assert.equal(await readFile(result.backup, "utf8"), legacy);
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(f.packageJson, f));

  const before = await readFile(f.launcher, "utf8");
  for (const artifact of ["dist/bundle/cli.js", "../pi-tui/dist/terminal.js"]) {
    const tamper = fakeRun(f, { onVerify: async ({ env }) => {
      const path = join(dirname(env.PI_PACKAGE_JSON), artifact);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "changed during gate\n");
    } });
    await assert.rejects(updateRuntime({ ...f, force: true }, tamper), /Runtime changed during validation/);
    assert.equal(await readFile(f.launcher, "utf8"), before);
  }
});

test("native trust override cannot be widened and is inserted before the prompt delimiter", () => {
  assert.deepEqual(confinedArgs([]), ["--no-approve"]);
  assert.deepEqual(confinedArgs(["--", "--approve"]), ["--no-approve", "--", "--approve"]);
  assert.deepEqual(confinedArgs(["--no-approve"]), ["--no-approve"]);
  for (const flag of ["--approve", "-a"]) assert.throws(() => confinedArgs([flag]), /does not permit/);
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
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node\nconsole.error("registry warning"); console.log(JSON.stringify(${JSON.stringify(installed.version)}));\n`, { mode: 0o700 });
  const output = join(f.root, "output.log"), fd = openSync(output, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/update-runtime.mjs", import.meta.url)),
      "--launcher", f.launcher, "--package-json", f.packageJson, "--", "update", "--all", "--no-approve"], {
      cwd: f.root, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, TMPDIR: f.root, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", fd, fd],
    });
  } finally { closeSync(fd); }
  assert.ifError(result.error);
  const stdout = readFileSync(output, "utf8");
  assert.equal(result.status, 23, stdout);
  assert.match(stdout, /already up to date/);
  assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), {
    args: ["update", "--extensions", "--no-approve"], manifest: f.packageJson, cwd: f.root,
  });
  assert.equal(await readFile(f.launcher, "utf8"), renderLauncher(f.packageJson, f));
});

test("shell trust normalization agrees with the native forwarding path, including literal prompt arguments", async t => {
  const f = await fixture(t);
  const cases = [[], [""], ["--"], ["--", "-a", "--approve"], ["-na", "--", "--approve"],
    ["hello\nworld", "a'b", '$(touch injected)', "`touch injected`"], ["-a"], ["--approve"],
    ["--no-approve", "--approve"], ["--version", "-na"], ["--no-approve", "--no-approve"],
    ["update", "--models", "--", "-a"], ["update", "--extensions", "--approve"]];
  for (const args of cases) {
    const log = join(f.root, "args.log"), fd = openSync(log, "w");
    let result;
    try { result = spawnSync(f.launcher, args, { cwd: f.root, env: f.env, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    assert.ifError(result.error);
    const output = readFileSync(log, "utf8");
    const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
    if (options.includes("-a") || options.includes("--approve")) {
      assert.equal(result.status, 1, output);
      assert.match(output, /does not permit --approve/);
    } else {
      assert.equal(result.status, 23, output);
      assert.deepEqual(JSON.parse(output).args, confinedArgs(args));
    }
  }
  await assert.rejects(lstat(join(f.root, "injected")), { code: "ENOENT" });
});

test("ordinary and forwarded native update commands keep the launcher PID and receive SIGTERM", async t => {
  const f = await fixture(t);
  const ready = join(f.root, "ready"), stopped = join(f.root, "stopped");
  await writeFile(join(f.packageRoot, "dist/bundle/cli.js"), `
    const fs = require("node:fs");
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stopped)}, "handled"); process.exit(0); });
    setInterval(() => {}, 1000);
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  `);
  for (const args of [[], ["update", "--models"]]) {
    await rm(ready, { force: true }); await rm(stopped, { force: true });
    const fd = openSync(join(f.root, "signal.log"), "w");
    const child = spawn(f.launcher, args, { env: f.env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const exited = once(child, "exit");
    let nativePid;
    try {
      const deadline = Date.now() + 5000;
      while (!nativePid && Date.now() < deadline) {
        try { nativePid = Number(await readFile(ready, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!nativePid) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(nativePid, "native CLI must start");
      assert.equal(nativePid, child.pid, "no intermediate Node parent may survive");
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
      assert.equal(await readFile(stopped, "utf8"), "handled");
      assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (nativePid && nativePid !== child.pid) {
        try { process.kill(nativePid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await exited;
    }
  }
});

test("launcher executes the protected updater after its source checkout disappears", async t => {
  const f = await fixture(t), sourceRoot = join(f.root, "source"), scripts = join(sourceRoot, "scripts");
  await mkdir(scripts, { recursive: true });
  const copy = join(scripts, "update-runtime.mjs");
  await cp(new URL("../scripts/update-runtime.mjs", import.meta.url), copy);
  const source = await import(pathToFileURL(copy).href);
  const original = await readFile(copy);
  await writeFile(copy, "throw new Error('SOURCE_EDITED_AFTER_LOAD');\n");
  const protectedCopy = await source.prepareUpdater(f.agentDir);
  assert.deepEqual(await readFile(protectedCopy), original, "name and content must use the same immutable source snapshot");
  await writeFile(f.launcher, source.renderLauncher(f.packageJson, { agentDir: f.agentDir }));
  await rm(sourceRoot, { recursive: true });
  for (const args of [["--version"], ["update", "--models"]]) {
    const fd = openSync(join(f.root, "independent.log"), "w");
    let result;
    try { result = spawnSync(f.launcher, args, { cwd: f.root, env: f.env, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    assert.ifError(result.error);
    assert.equal(result.status, 23, await readFile(join(f.root, "independent.log"), "utf8"));
  }
});

test("updater snapshots publish concurrently without overwriting links or altered code", async t => {
  const f = await fixture(t);
  assert.deepEqual(await Promise.all([prepareUpdater(f.agentDir), prepareUpdater(f.agentDir)]), [f.updater, f.updater]);
  await chmod(f.updater, 0o600);
  await writeFile(f.updater, "throw new Error('altered');\n");
  await assert.rejects(prepareUpdater(f.agentDir), /differs from source/);
  await rm(f.updater);
  await symlink(fileURLToPath(new URL("../scripts/update-runtime.mjs", import.meta.url)), f.updater);
  await assert.rejects(prepareUpdater(f.agentDir), /differs from source/);
  await rm(dirname(f.updater), { recursive: true });
  await mkdir(join(f.root, "outside"));
  await symlink(join(f.root, "outside"), dirname(f.updater));
  await assert.rejects(prepareUpdater(f.agentDir), /symbolic link/);
  assert.deepEqual(await readdir(join(f.root, "outside")), []);
});

test("explicit agent-directory overrides reach native commands without executing another directory's updater", async t => {
  const f = await fixture(t), other = join(f.root, "other agent");
  await writeFile(join(f.packageRoot, "dist/bundle/cli.js"), "console.log(process.env.PI_CODING_AGENT_DIR);\n");
  for (const args of [["install", "npm:fixture"], ["update", "--models"]]) {
    const log = join(f.root, "override.log"), fd = openSync(log, "w");
    let result;
    try { result = spawnSync(f.launcher, args, { env: { ...process.env, PI_CODING_AGENT_DIR: other }, stdio: ["ignore", fd, fd] }); }
    finally { closeSync(fd); }
    assert.ifError(result.error);
    if (args[0] === "install") {
      assert.equal(result.status, 0);
      assert.equal((await readFile(log, "utf8")).trim(), other);
    } else {
      assert.notEqual(result.status, 0, "updater must be installed and validated for this agent directory");
      assert.match(await readFile(log, "utf8"), /MODULE_NOT_FOUND/);
    }
  }
});
