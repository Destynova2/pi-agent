#!/usr/bin/env node
// Private Pi runtimes are immutable after activation. Only the launcher changes.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@earendil-works/pi-coding-agent";
const SELF = fileURLToPath(import.meta.url);
const UPDATER_CODE = readFileSync(SELF);
const UPDATER_DIGEST = createHash("sha256").update(UPDATER_CODE).digest("hex");
const SOURCE = resolve(dirname(SELF), "..");
const MANIFEST_SUFFIX = join("node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const DEFAULT_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

function updaterPath(agentDir) {
  return join(resolve(agentDir), "runtime-updaters", `${UPDATER_DIGEST}.mjs`);
}

// First-party updater code lives under the same protected root as Pi settings.
// Publish exclusively; an existing snapshot must match, never silently overwrite it.
export async function prepareUpdater(agentDir = DEFAULT_AGENT_DIR) {
  const path = updaterPath(agentDir), directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Updater storage must not be a symbolic link");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, UPDATER_CODE, { flag: "wx", mode: 0o400 });
    try { await link(temporary, path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(UPDATER_CODE)) {
      throw new Error(`Updater snapshot differs from source: ${path}`);
    }
    return path;
  } finally { await rm(temporary, { force: true }); }
}

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
  if (compareVersions(version, "1.0.4") < 0 || versionParts(version)[0] !== 1n) {
    throw new Error(`Pi ${version} is outside the supported 1.x API range (minimum 1.0.4). Validate a new major before upgrading. The active runtime is unchanged.`);
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

async function runtimeDigest(root) {
  const digest = createHash("sha256");
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      digest.update(JSON.stringify(path.slice(root.length)));
      if (entry.isSymbolicLink()) { digest.update("link"); digest.update(JSON.stringify(await readlink(path))); }
      else if (entry.isDirectory()) { digest.update("directory"); await walk(path); }
      else if (entry.isFile()) { digest.update("file"); digest.update(createHash("sha256").update(await readFile(path)).digest()); }
      else throw new Error(`Non-regular runtime artifact refused: ${path}`);
    }
  }
  await walk(root);
  return digest.digest("hex");
}

export function confinedArgs(args) {
  // These native CLI commands edit configuration or print help, without loading
  // project extensions or connecting servers. They reject session trust flags.
  if (args[0] === "mcp" && [undefined, "add", "remove", "help", "--help", "-h"].includes(args[1])) return args;
  const boundary = args.indexOf("--"), options = boundary < 0 ? args : args.slice(0, boundary);
  if (options.some(arg => arg === "--approve" || arg === "-a")) throw new Error("The confined launcher does not permit --approve; project code must remain untrusted");
  if (options.includes("--no-approve") || options.includes("-na")) return args;
  return boundary < 0 ? [...args, "--no-approve"] : [...options, "--no-approve", ...args.slice(boundary)];
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

export function renderLauncher(packageJson, { node = process.execPath, agentDir = DEFAULT_AGENT_DIR, sourceRoot = SOURCE } = {}) {
  const manifest = resolve(packageJson);
  return `#!/bin/sh
# pi-agent private runtime launcher
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
export PI_PACKAGE_JSON=${quote(manifest)}
if [ -z "\${PI_CODING_AGENT_DIR:-}" ]; then PI_CODING_AGENT_DIR=${quote(resolve(agentDir))}; fi
export PI_CODING_AGENT_DIR
# Configuration-only MCP commands have their own parser, without session flags.
if [ "\${1-}" = mcp ]; then
  case "\${2-}" in
    ''|add|remove|help|--help|-h) exec ${quote(node)} ${quote(join(dirname(manifest), "dist/bundle/cli.js"))} "$@" ;;
  esac
fi
# Rotate only the original arguments, preserving quoting and the prompt delimiter.
pi_argc=$#
pi_delimiter=
pi_trust_flag=
while [ "$pi_argc" -gt 0 ]; do
  pi_arg=$1
  shift
  if [ -z "$pi_delimiter" ]; then
    case "$pi_arg" in
      --approve|-a) echo 'The confined launcher does not permit --approve; project code must remain untrusted' >&2; exit 1 ;;
      --no-approve|-na) pi_trust_flag=1 ;;
      --)
        if [ -z "$pi_trust_flag" ]; then set -- "$@" --no-approve; pi_trust_flag=1; fi
        pi_delimiter=1 ;;
    esac
  fi
  set -- "$@" "$pi_arg"
  pi_argc=$((pi_argc - 1))
done
if [ -z "$pi_trust_flag" ]; then set -- "$@" --no-approve; fi
if [ "\${1-}" = update ]; then
  exec ${quote(node)} "$PI_CODING_AGENT_DIR"/${quote(join("runtime-updaters", basename(updaterPath(agentDir))))} --launcher "$0" --package-json "$PI_PACKAGE_JSON" --source-root ${quote(resolve(sourceRoot))} -- "$@"
fi
exec ${quote(node)} ${quote(join(dirname(manifest), "dist/bundle/cli.js"))} "$@"
`;
}

async function launcherSnapshot(launcher) {
  const info = await lstat(launcher);
  if (!info.isFile()) throw new Error(`Launcher must be a regular file, not a symlink: ${launcher}`);
  return { content: await readFile(launcher, "utf8"), mode: info.mode & 0o777 };
}

async function activate(launcher, snapshot, manifest, options) {
  const current = await launcherSnapshot(launcher);
  if (current.content !== snapshot.content || current.mode !== snapshot.mode) {
    throw new Error("Launcher changed during validation; refusing to overwrite it");
  }
  const backup = `${launcher}.backup-${randomUUID()}`, temporary = `${launcher}.${randomUUID()}.tmp`;
  await writeFile(backup, snapshot.content, { flag: "wx", mode: snapshot.mode });
  try {
    await writeFile(temporary, renderLauncher(manifest, options), { flag: "wx", mode: snapshot.mode | 0o100 });
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

async function verifyRuntime(runtime, logs, run, options) {
  // Ensure subprocesses invoking pi also see the candidate, not the live launcher.
  const bin = join(logs, "bin");
  await mkdir(bin);
  await prepareUpdater(options.agentDir);
  await writeFile(join(bin, "pi"), renderLauncher(runtime.manifest, options), { mode: 0o700 });
  await run("npm", ["run", "verify:integration"], {
    cwd: options.sourceRoot,
    env: {
      ...process.env,
      PI_PACKAGE_JSON: runtime.manifest,
      PI_CODING_AGENT_DIR: options.agentDir,
      PATH: `${bin}:${process.env.PATH}`,
    },
    log: join(logs, "verify.log"),
  });
}

export async function updateRuntime({ launcher, packageJson, force = false, installLauncher = false,
  agentDir = DEFAULT_AGENT_DIR, sourceRoot = SOURCE }, { run = runCommand } = {}) {
  const options = { agentDir: resolve(agentDir), sourceRoot: resolve(sourceRoot) };
  launcher = resolve(launcher);
  const runtime = await runtimeInfo(packageJson);
  const snapshot = await launcherSnapshot(launcher);
  if (!installLauncher && snapshot.content !== renderLauncher(runtime.manifest, options)) {
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
      requireSupported(runtime.version);
      const digest = await runtimeDigest(runtime.prefix);
      await verifyRuntime(runtime, logs, run, options);
      if (await runtimeDigest(runtime.prefix) !== digest) throw new Error("Runtime changed during validation");
      const backup = await activate(launcher, snapshot, runtime.manifest, options);
      return { ...runtime, backup, logs };
    }
    const latest = JSON.parse(await run("npm", ["view", PACKAGE, "dist-tags.latest", "--json"], { cwd: options.sourceRoot, log: join(logs, "latest.log"), capture: true }));
    const comparison = compareVersions(latest, runtime.version);
    if (comparison < 0) throw new Error(`Registry version ${latest} is older than active Pi ${runtime.version}; refusing to downgrade`);
    if (comparison === 0 && !force) {
      requireSupported(runtime.version);
      console.log(`Pi ${runtime.version} is already up to date. Use --force to replace a legacy patched runtime with a fresh installation.`);
      return { ...runtime, logs };
    }
    requireSupported(latest);
    candidate = await mkdtemp(join(dirname(runtime.prefix), `${latest}-native-`));
    await writeFile(join(candidate, "package.json"), JSON.stringify({
      private: true,
      dependencies: { [PACKAGE]: latest },
    }, null, 2) + "\n");
    await run("npm", ["install", "--prefix", candidate, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: options.sourceRoot, log: join(logs, "install.log") });
    const next = await runtimeInfo(join(candidate, MANIFEST_SUFFIX));
    if (next.version !== latest) throw new Error(`Installed Pi ${next.version}, expected ${latest}`);
    const digest = await runtimeDigest(next.prefix);
    await verifyRuntime(next, logs, run, options);
    if (await runtimeDigest(next.prefix) !== digest) throw new Error("Runtime changed during validation");
    const backup = await activate(launcher, snapshot, next.manifest, options);
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
    else if (["--launcher", "--package-json", "--source-root"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = { "--launcher": "launcher", "--package-json": "packageJson", "--source-root": "sourceRoot" }[args[i]];
      options[key] = args[++i];
    } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!options.packageJson || (options.installLauncher ? forwarded !== undefined : forwarded === undefined)) {
    throw new Error("Use --install-launcher --package-json <manifest>, or invoke pi update through the installed launcher");
  }
  if (options.installLauncher) { await updateRuntime(options); return; }
  confinedArgs(forwarded); // Reject an unsafe override before installing or updating anything.
  const update = selfUpdateOptions(forwarded);
  let runtime = await runtimeInfo(options.packageJson);
  if (update) runtime = await updateRuntime({ ...options, force: update.force });
  if (!update || update.extensions) {
    // Keep native arguments, output, working directory and exit status intact.
    process.execve(process.execPath, [process.execPath, runtime.cli, ...confinedArgs(update ? update.extensionArgs : forwarded)],
      { ...process.env, PI_PACKAGE_JSON: runtime.manifest });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === SELF) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`pi runtime update: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}
