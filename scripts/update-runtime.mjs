#!/usr/bin/env node
// Private Pi runtimes are immutable after activation. Only the launcher changes.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchProjectTrust, TRUST_TARGETS_BY_VERSION } from "./patch-project-trust.mjs";
import { patchPaste } from "./patch-paste.mjs";
import { TARGETS_BY_VERSION } from "../patches/paste-keepalive.mjs";

const PACKAGE = "@earendil-works/pi-coding-agent";
const SELF = fileURLToPath(import.meta.url);
const SOURCE = resolve(dirname(SELF), "..");
const MANIFEST_SUFFIX = join("node_modules", "@earendil-works", "pi-coding-agent", "package.json");

function versionParts(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable Pi version, received ${JSON.stringify(version)}`);
  }
  return version.split(".").map(BigInt);
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function requireSupported(version) {
  versionParts(version);
  if (!Object.hasOwn(TRUST_TARGETS_BY_VERSION, version) || !Object.hasOwn(TARGETS_BY_VERSION, version)) {
    throw new Error(`Pi ${version} has no validated trust/paste patches in ${SOURCE}. Validate and pin its published artifacts before retrying pi update. The active runtime is unchanged.`);
  }
}

async function runtimeInfo(packageJson) {
  const manifest = resolve(packageJson);
  if (!manifest.endsWith(`/${MANIFEST_SUFFIX}`)) throw new Error("Expected a private node_modules/@earendil-works/pi-coding-agent/package.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  if (data.name !== PACKAGE) throw new Error(`Expected ${PACKAGE} at ${manifest}`);
  versionParts(data.version);
  const root = dirname(manifest), prefix = manifest.slice(0, -MANIFEST_SUFFIX.length - 1);
  const cli = join(root, "dist", "bundle", "cli.js");
  if (!(await lstat(cli)).isFile()) throw new Error(`Expected a regular CLI file: ${cli}`);
  return { manifest, root, prefix, cli, version: data.version };
}

async function checkPatches(root) {
  await patchProjectTrust(root, { checkOnly: true });
  const paste = await patchPaste(root, { checkOnly: true });
  if (paste.skipped.length) throw new Error(`Incomplete paste patch: ${paste.skipped.join(", ")}`);
}

// Intercept only valid self-update requests. Pi retains help, validation and every
// extension/model-only command, including positional sources and --extension.
export function selfUpdateOptions(args) {
  if (args[0] !== "update") return undefined;
  const flags = new Set(), sources = [];
  const allowed = new Set(["--self", "--extensions", "--all", "--force", "--approve", "-a", "--no-approve", "-na"]);
  for (const arg of args.slice(1)) {
    if (allowed.has(arg)) flags.add(arg);
    else if (arg === "self" || arg === "pi") sources.push(arg);
    else return undefined;
  }
  if (sources.length > 1) return undefined;
  if (flags.has("--all") && (sources.length || flags.has("--self") || flags.has("--extensions"))) return undefined;
  if (flags.has("--extensions") && !flags.has("--self") && !sources.length) return undefined;
  const extensions = flags.has("--all") || flags.has("--extensions");
  const extensionArgs = ["update", "--extensions", ...args.slice(1).filter(arg => ["--approve", "-a", "--no-approve", "-na", "--force"].includes(arg))];
  return { force: flags.has("--force"), extensions, extensionArgs };
}

function quote(value) {
  if (/[\0\r\n]/.test(value)) throw new Error("Launcher paths must not contain NUL or line breaks");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderLauncher(packageJson, { node = "node", updater = SELF } = {}) {
  const manifest = resolve(packageJson);
  return `#!/bin/sh
# pi-agent private runtime launcher
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
export PI_PACKAGE_JSON=${quote(manifest)}
if [ "\${1-}" = update ]; then
  exec ${quote(node)} ${quote(updater)} --launcher "$0" --package-json "$PI_PACKAGE_JSON" -- "$@"
fi
exec ${quote(node)} ${quote(join(dirname(manifest), "dist/bundle/cli.js"))} "$@"
`;
}

async function launcherSnapshot(launcher) {
  const info = await lstat(launcher);
  if (!info.isFile()) throw new Error(`Launcher must be a regular file, not a symlink: ${launcher}`);
  return { content: await readFile(launcher, "utf8"), mode: info.mode & 0o777 };
}

async function activate(launcher, snapshot, manifest) {
  const current = await launcherSnapshot(launcher);
  if (current.content !== snapshot.content || current.mode !== snapshot.mode) {
    throw new Error("Launcher changed during validation; refusing to overwrite it");
  }
  const backup = `${launcher}.backup-${randomUUID()}`, temporary = `${launcher}.${randomUUID()}.tmp`;
  await writeFile(backup, snapshot.content, { flag: "wx", mode: snapshot.mode });
  try {
    await writeFile(temporary, renderLauncher(manifest), { flag: "wx", mode: snapshot.mode | 0o100 });
    await rename(temporary, launcher);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Launcher activated. Backup: ${backup}`);
  return backup;
}

export function runCommand(command, args, { cwd = SOURCE, env = process.env, log, capture = false } = {}) {
  console.log(`Running ${command} ${args.join(" ")}${log ? ` (log: ${log})` : ""}`);
  if (capture && !log) throw new Error("Captured commands require a log path");
  const fd = log ? openSync(log, "w", 0o600) : undefined;
  let stdout = fd;
  let result;
  try {
    if (capture) stdout = openSync(`${log}.stdout`, "w", 0o600);
    result = spawnSync(command, args, { cwd, env, stdio: ["inherit", stdout ?? "inherit", fd ?? "inherit"] });
  } finally {
    if (stdout !== undefined && stdout !== fd) closeSync(stdout);
    if (fd !== undefined) closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    const error = new Error(`${command} failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`})${log ? `; see ${log}` : ""}`);
    error.exitCode = result.status || 1;
    throw error;
  }
  return log ? readFileSync(capture ? `${log}.stdout` : log, "utf8") : "";
}

async function verifyRuntime(runtime, logs, run) {
  // Ensure subprocesses invoking pi also see the candidate, not the live launcher.
  const bin = join(logs, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), renderLauncher(runtime.manifest), { mode: 0o700 });
  let fixture = process.env.PI_PASTE_PACKAGE_JSON;
  if (!fixture) {
    const prefix = join(logs, "paste-fixture");
    await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `${PACKAGE}@1.0.0`], {
      log: join(logs, "paste-fixture.log"),
    });
    fixture = join(prefix, MANIFEST_SUFFIX);
  }
  await run("npm", ["run", "verify:integration"], {
    env: {
      ...process.env,
      PI_PACKAGE_JSON: runtime.manifest,
      PI_PASTE_PACKAGE_JSON: fixture,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      PATH: `${bin}:${process.env.PATH}`,
    },
    log: join(logs, "verify.log"),
  });
}

export async function updateRuntime({ launcher, packageJson, force = false, installLauncher = false }, { run = runCommand } = {}) {
  launcher = resolve(launcher);
  const runtime = await runtimeInfo(packageJson);
  const snapshot = await launcherSnapshot(launcher);
  if (!installLauncher && snapshot.content !== renderLauncher(runtime.manifest)) {
    throw new Error("Launcher no longer selects this runtime or was edited; refusing to overwrite it");
  }
  const lock = `${launcher}.update-lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another update holds ${lock}; if interrupted, remove that directory only after checking no updater is running`);
    throw error;
  }
  let candidate;
  try {
    const logs = await mkdtemp(join(tmpdir(), "pi-runtime-update-"));
    console.log(`Update logs: ${logs}`);
    if (installLauncher) {
      await checkPatches(runtime.root);
      await verifyRuntime(runtime, logs, run);
      await checkPatches(runtime.root);
      const backup = await activate(launcher, snapshot, runtime.manifest);
      return { ...runtime, backup, logs };
    }
    const latest = JSON.parse(await run("npm", ["view", PACKAGE, "dist-tags.latest", "--json"], { log: join(logs, "latest.log"), capture: true }));
    const comparison = compareVersions(latest, runtime.version);
    if (comparison < 0) throw new Error(`Registry version ${latest} is older than active Pi ${runtime.version}; refusing to downgrade`);
    if (comparison === 0 && !force) {
      await checkPatches(runtime.root);
      console.log(`Pi ${runtime.version} is already up to date; trust and paste patches verified.`);
      return { ...runtime, logs };
    }
    requireSupported(latest);
    candidate = await mkdtemp(join(dirname(runtime.prefix), `${latest}-patched-`));
    await writeFile(join(candidate, "package.json"), JSON.stringify({
      private: true,
      dependencies: { [PACKAGE]: latest },
      overrides: { "@earendil-works/pi-tui": latest },
    }, null, 2) + "\n");
    await run("npm", ["install", "--prefix", candidate, "--ignore-scripts", "--no-audit", "--no-fund"], { log: join(logs, "install.log") });
    const next = await runtimeInfo(join(candidate, MANIFEST_SUFFIX));
    if (next.version !== latest) throw new Error(`Installed Pi ${next.version}, expected ${latest}`);
    await patchProjectTrust(next.root);
    await patchPaste(next.root);
    await checkPatches(next.root);
    await verifyRuntime(next, logs, run);
    await checkPatches(next.root);
    const backup = await activate(launcher, snapshot, next.manifest);
    console.log(`Updated Pi ${runtime.version} to ${next.version}. Previous runtime retained: ${runtime.prefix}`);
    return { ...next, backup, logs };
  } catch (error) {
    if (candidate) console.error(`Candidate retained for diagnosis: ${candidate}`);
    throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node scripts/update-runtime.mjs --install-launcher --package-json <installed manifest> [--launcher <path>]\nRuns the native integration gate, backs up the launcher, then enables pi update. Requires this source checkout to remain available.");
    return;
  }
  const options = { launcher: join(homedir(), ".local/bin/pi") };
  let forwarded;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") { forwarded = args.slice(i + 1); break; }
    if (args[i] === "--install-launcher") options.installLauncher = true;
    else if (["--launcher", "--package-json"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[args[i] === "--launcher" ? "launcher" : "packageJson"] = args[++i];
    } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!options.packageJson || (options.installLauncher ? forwarded !== undefined : !forwarded?.length)) {
    throw new Error("Use --install-launcher --package-json <manifest>, or invoke pi update through the installed launcher");
  }
  if (options.installLauncher) { await updateRuntime(options); return; }
  const update = selfUpdateOptions(forwarded);
  let runtime = await runtimeInfo(options.packageJson);
  if (update) runtime = await updateRuntime({ ...options, force: update.force });
  if (!update || update.extensions) {
    // Keep native arguments, output, working directory and exit status intact.
    const result = spawnSync(process.execPath, [runtime.cli, ...(update ? update.extensionArgs : forwarded)], {
      cwd: process.cwd(), env: { ...process.env, PI_PACKAGE_JSON: runtime.manifest }, stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`pi runtime update: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}
