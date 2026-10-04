#!/usr/bin/env node
// Idempotent installer for the pi-agent configuration into a target directory.
// Node stdlib only. See README.md and docs/configuration.md (pi) for the contract.
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isSubPath, isSymlink, pathExists } from "./lib.mjs";

export const MANAGED_DIRS = ["agents", "extensions", "lib", "gates"];
export const MANAGED_FILES = ["keybindings.json", "scripts/codex-shell.mjs", "scripts/codex-tool.mjs", "scripts/codex-network.mjs", "scripts/metal-backend.mjs", "scripts/confined-tool.mjs", "scripts/confined-lsp-worker.mjs"];
const RETIRED_FILES = ["tool-policy.json", "extensions/tool-policy/core.ts", "extensions/tool-policy/task.ts", "extensions/tool-policy/tests/policy.test.ts", "extensions/tool-policy/tests/task.test.ts", "extensions/tool-policy/tests/skills.test.ts"];
export const MANAGED_ENTRIES = [...MANAGED_DIRS, ...MANAGED_FILES, "settings.json", "tool-policy.json"];

const DEFAULT_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultTarget(env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Resolves a path to its canonical form (symlinks traversed) even if it does not
 * exist yet: walks up to the first existing ancestor, resolves it with `realpath`, then
 * appends the nonexistent suffix as-is. Two paths designating the same location through
 * legitimate aliases (e.g. macOS `/tmp` -> `/private/tmp`) thus become comparable, without
 * rejecting every path that happens to contain `/tmp`.
 */
async function canonicalPath(path) {
  const resolved = resolve(path);
  let dir = resolved;
  const suffixParts = [];
  while (!(await pathExists(dir))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    suffixParts.unshift(basename(dir));
    dir = parent;
  }
  let real;
  try {
    real = await realpath(dir);
  } catch {
    real = dir;
  }
  return suffixParts.length > 0 ? join(real, ...suffixParts) : real;
}

/** Lists every symlink (at any depth) under `root`, without descending into them. */
async function scanSymlinks(root) {
  const found = [];
  async function walk(dir) {
    if (!(await pathExists(dir))) return;
    if (await isSymlink(dir)) {
      found.push(dir);
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(p);
        continue;
      }
      if (entry.isDirectory()) await walk(p);
    }
  }
  await walk(root);
  return found;
}

/**
 * Checks, before any mutation, that source and target are distinct and non-nested
 * locations (comparison on canonical paths: system symlinks like `/tmp` <-> `/private/tmp`
 * on macOS are thus resolved to the same location rather than being rejected outright),
 * that the target itself is not a symlink, and that no managed resource (source or
 * target, the entry itself and all its content) contains one: a symlink inside a managed
 * directory would allow writing outside the target during sync.
 */
async function assertSafeTarget(sourceRoot, target) {
  if (await isSymlink(target)) {
    throw new Error(`refuse: target is a symbolic link (${target})`);
  }

  const sourceCanonical = await canonicalPath(sourceRoot);
  const targetCanonical = await canonicalPath(target);
  if (sourceCanonical === targetCanonical) {
    throw new Error(`refuse: target identical to source (${target}). This repo remains the source, not installed storage.`);
  }
  if (isSubPath(sourceCanonical, targetCanonical) || isSubPath(targetCanonical, sourceCanonical)) {
    throw new Error(`refuse: source and target overlap (${sourceRoot} / ${target})`);
  }

  const symlinkEntries = [];
  for (const entry of MANAGED_ENTRIES) {
    for (const root of [sourceRoot, target]) {
      for (let parent = dirname(join(root, entry)); parent !== root; parent = dirname(parent)) {
        if (await isSymlink(parent)) symlinkEntries.push(parent);
      }
      symlinkEntries.push(...(await scanSymlinks(join(root, entry))));
    }
  }
  if (symlinkEntries.length > 0) {
    throw new Error(
      `refuse: symbolic link(s) detected in managed resources, risk of writing outside the target:\n${symlinkEntries.join("\n")}`,
    );
  }
}

async function backupExisting(target, entries) {
  const existing = [];
  for (const entry of entries) {
    if (await pathExists(join(target, entry))) existing.push(entry);
  }
  if (existing.length === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `${target}.backup-${stamp}`;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);
  for (const entry of existing) {
    await mkdir(dirname(join(backupDir, entry)), { recursive: true });
    await cp(join(target, entry), join(backupDir, entry), { recursive: true });
  }
  return backupDir;
}

/** Lists regular files under `dir` (relative paths). Refuses any symlink. */
async function listFiles(dir) {
  const results = [];
  async function walk(current, relBase) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const rel = relBase ? join(relBase, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`refuse: symbolic link encountered during copy (${abs})`);
      }
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }
  await walk(dir, "");
  return results;
}

/**
 * Copies file by file from `src` to `dest`, touching only the paths present
 * in `src`. Never deletes `dest`: any file/directory the user added in a
 * managed directory (personal extension, note, etc.) that does not exist in `src` stays
 * intact.
 */
async function syncDir(src, dest) {
  if (!(await pathExists(src))) return false;
  await mkdir(dest, { recursive: true });
  const files = await listFiles(src);
  for (const rel of files) {
    const from = join(src, rel);
    const to = join(dest, rel);
    await mkdir(dirname(to), { recursive: true });
    await rm(to, { force: true });
    await cp(from, to);
  }
  return true;
}

async function syncFile(src, dest) {
  if (!(await pathExists(src))) return false;
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { force: true });
  await cp(src, dest);
  return true;
}

function validateSettingsSchema(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`refuse: ${label} is not a valid JSON object (${label})`);
  }
  if ("packages" in value) {
    const ok = Array.isArray(value.packages) && value.packages.every((p) => typeof p === "string" ||
      (p && typeof p === "object" && !Array.isArray(p) && typeof p.source === "string" &&
        Object.entries(p).every(([key, entry]) => key === "source" ||
          (["extensions", "skills", "prompts", "themes"].includes(key) && Array.isArray(entry) && entry.every(item => typeof item === "string")))));
    if (!ok) throw new Error(`refuse: ${label}.packages must contain strings or filtered package objects`);
  }
}

/** Reads and validates a minimal settings.json, before any mutation. Absent => empty object. */
async function readSettings(path, label) {
  if (!(await pathExists(path))) return {};
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`refuse: invalid JSON in ${label} (${path}): ${err.message}`);
  }
  validateSettingsSchema(parsed, label);
  return parsed;
}

/**
 * Identity of a `packages` entry without its trailing version marker (`@version` or
 * `@sha`), so an old version can be replaced by the new one without duplicating it.
 * An `@` immediately following `/` or `:` is part of an npm scope (`npm:@scope/name`),
 * not a version marker: it is not stripped.
 */
export function packageIdentity(spec) {
  if (typeof spec !== "string") spec = spec.source;
  const at = spec.lastIndexOf("@");
  if (at <= 0) return spec;
  const before = spec[at - 1];
  if (before === "/" || before === ":") return spec;
  return spec.slice(0, at);
}

/**
 * Preserves preferences already present in the target (and the personal packages it
 * added). Only packages managed by the source (same identity) are replaced by the
 * source's version; personal target packages with no equivalent in the source are
 * kept as-is.
 */
export function mergeSettings(sourceSettings, targetSettings) {
  const merged = { ...sourceSettings, ...targetSettings };
  const sourcePackages = Array.isArray(sourceSettings.packages) ? sourceSettings.packages : [];
  const targetPackages = Array.isArray(targetSettings.packages) ? targetSettings.packages : [];
  const managedIdentities = new Set(sourcePackages.map(packageIdentity));
  const personalPackages = targetPackages.filter((p) => !managedIdentities.has(packageIdentity(p)));
  merged.packages = [...sourcePackages, ...personalPackages];
  return merged;
}

function installPackages(packages, target, env) {
  const failures = [];
  const installed = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry.source;
    const res = spawnSync("pi", ["install", source, "--no-approve"], {
      env: { ...env, PI_CODING_AGENT_DIR: target },
      stdio: "pipe",
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) {
      failures.push({
        source,
        status: res.status ?? null,
        message: res.error ? res.error.message : (res.stderr || "").trim(),
      });
    } else {
      installed.push(source);
    }
  }
  return { installed, failures };
}

/**
 * Installs the configuration from `sourceRoot` (the current repo by default) into `target`.
 * Never touches auth.json, sessions/, models-store.json, trust.json, or any file outside
 * MANAGED_ENTRIES: those remain Pi's and the user's responsibility.
 *
 * Order: full validation (target path, source/target safety, JSON schema) before any
 * mutation, then backup, then copy, so an invalid entry never touches already-installed
 * resources.
 */
export async function runInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  target,
  noPackages = false,
  env = process.env,
} = {}) {
  if (target !== undefined && (typeof target !== "string" || target.trim() === "")) {
    throw new Error("refuse: --target must be a non-empty path");
  }
  sourceRoot = resolve(sourceRoot);
  const resolvedTarget = resolve(target ?? defaultTarget(env));

  await assertSafeTarget(sourceRoot, resolvedTarget);

  const sourceSettings = await readSettings(join(sourceRoot, "settings.json"), "settings.json source");
  const targetSettings = await readSettings(join(resolvedTarget, "settings.json"), "settings.json target");
  const mergedSettings = mergeSettings(sourceSettings, targetSettings);
  // Strict tool execution has no unrestricted-shell mode.
  mergedSettings.shellPath = join(resolvedTarget, "scripts/codex-shell.mjs");

  await mkdir(resolvedTarget, { recursive: true });
  const backupDir = await backupExisting(resolvedTarget, MANAGED_ENTRIES);

  try {
    const syncedDirs = [];
    for (const dir of MANAGED_DIRS) {
      if (await syncDir(join(sourceRoot, dir), join(resolvedTarget, dir))) syncedDirs.push(dir);
    }
    const syncedFiles = [];
    for (const file of MANAGED_FILES) {
      if (await syncFile(join(sourceRoot, file), join(resolvedTarget, file))) {
        syncedFiles.push(file);
        if (file === "scripts/codex-shell.mjs") await chmod(join(resolvedTarget, file), 0o755);
      }
    }

    // Retire only known legacy files, after backup; preserve personal extensions.
    for (const file of RETIRED_FILES) await rm(join(resolvedTarget, file), { force: true });
    await writeFile(join(resolvedTarget, "settings.json"), `${JSON.stringify(mergedSettings, null, 2)}\n`);

    let installed = [];
    let packageFailures = [];
    if (!noPackages) {
      ({ installed, failures: packageFailures } = installPackages(sourceSettings.packages ?? [], resolvedTarget, env));
      // pi install may rewrite package entries; preserve the resource filters selected above.
      const installedSettings = await readSettings(join(resolvedTarget, "settings.json"), "installed settings.json");
      await writeFile(join(resolvedTarget, "settings.json"), `${JSON.stringify({ ...installedSettings, packages: mergedSettings.packages }, null, 2)}\n`);
    }

    return {
      sourceRoot,
      target: resolvedTarget,
      backupDir,
      syncedDirs,
      syncedFiles,
      packages: sourceSettings.packages ?? [],
      installedPackages: installed,
      packageFailures,
      skippedPackages: noPackages,
    };
  } catch (err) {
    // The backup already happened: we report it even if the rest fails, so
    // the user knows where to find their previous state.
    err.backupDir = backupDir;
    throw err;
  }
}

function parseArgs(argv) {
  const out = { target: undefined, noPackages: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      if (i + 1 >= argv.length) throw new Error("--target requires a path");
      out.target = argv[++i];
    } else if (arg === "--no-packages") out.noPackages = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/install.mjs [--target <path>] [--no-packages]

  --target <path>     Target agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --no-packages       Do not invoke \`pi install\` (offline mode)
`);
}

function printSummary(result) {
  console.log(`install: target ${result.target}`);
  if (result.backupDir) console.log(`install: prior backup in ${result.backupDir}`);
  console.log(`install: synced directories: ${result.syncedDirs.join(", ") || "(none)"}`);
  console.log(`install: synced files: ${result.syncedFiles.join(", ") || "(none)"}`);
  if (result.skippedPackages) {
    console.log("install: packages skipped (--no-packages)");
  } else if (result.packageFailures.length > 0) {
    console.log(`install: installed packages: ${result.installedPackages.join(", ") || "(none)"}`);
    for (const failure of result.packageFailures) {
      console.error(`install: package failure ${failure.source}: ${failure.message}`);
    }
    console.error("install: finished with package failures, do not consider this a full success");
  } else {
    console.log(`install: installed packages: ${result.installedPackages.join(", ") || "(none)"}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`install: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  try {
    const result = await runInstall({ target: args.target, noPackages: args.noPackages });
    printSummary(result);
    process.exitCode = result.packageFailures.length > 0 ? 1 : 0;
  } catch (err) {
    if (err.backupDir) console.error(`install: prior backup kept in ${err.backupDir} despite the failure`);
    console.error(`install: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
