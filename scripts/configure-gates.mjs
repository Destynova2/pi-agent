#!/usr/bin/env node
// Explicitly initializes a project's gate policy, never guessing the required
// commands nor weakening gates.py (gates/pi-orchestrate/gates.py). Stdlib only.
//
// Writes ~/.config/pi-orchestrate/projects/<sha256(real root)[:20]>.json with
// { root, required }. Refuses to overwrite an existing policy (file or symlink,
// including a symlink on one of the managed parent directories).
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Truncated sha256 hex of the real root path, identical to key() in gates.py. */
export function policyKey(realRoot) {
  return createHash("sha256").update(realRoot).digest("hex").slice(0, 20);
}

/** Resolves the real path (symlinks included) of an existing project directory. */
export async function resolveProjectRoot(projectPath) {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new Error("--project is required and must be a non-empty path");
  }
  let real;
  try {
    real = await realpath(projectPath);
  } catch (err) {
    throw new Error(`--project not found: ${projectPath} (${err.code ?? err.message})`);
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new Error(`--project must be a directory: ${real}`);
  return real;
}

/** Validates a JSON of commands: non-empty array of argv (arrays of non-empty strings). */
export function parseRequiredCommands(json) {
  let commands;
  try {
    commands = JSON.parse(json);
  } catch (err) {
    throw new Error(`--commands is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("--commands must be a non-empty JSON array of argv commands");
  }
  commands.forEach((argv, i) => {
    const bad =
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((s) => typeof s === "string" && s.length > 0);
    if (bad) {
      throw new Error(`--commands[${i}] must be a non-empty array of non-empty strings`);
    }
  });
  return commands;
}

/** Refuses any symlink at an existing path. */
async function refuseSymlink(path) {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null; // does not exist
  }
  if (st.isSymbolicLink()) throw new Error(`refuse: ${path} is a symbolic link`);
  return st;
}

/** Creates (mode 0700) ~/.config/pi-orchestrate/projects without ever following a parent symlink. */
async function securedProjectsDir(homeDir) {
  await refuseSymlink(homeDir);
  let cur = homeDir;
  for (const seg of [".config", "pi-orchestrate", "projects"]) {
    cur = join(cur, seg);
    const st = await refuseSymlink(cur);
    if (st) {
      if (!st.isDirectory()) throw new Error(`refuse: ${cur} is not a directory`);
    } else {
      await mkdir(cur, { mode: 0o700 });
    }
  }
  return cur;
}

/**
 * Writes the gate policy for a project. Never overwrites an existing file
 * (exclusive creation, also refuses any symlink in place or on a managed parent directory).
 */
export async function configureGates({ project, commandsJson, homeDir = homedir() }) {
  const root = await resolveProjectRoot(project);
  const required = parseRequiredCommands(commandsJson);
  const projectsDir = await securedProjectsDir(homeDir);
  const key = policyKey(root);
  const path = join(projectsDir, `${key}.json`);
  await refuseSymlink(path);
  const existing = await stat(path).catch(() => null);
  if (existing) throw new Error(`refuse to overwrite an existing policy: ${path}`);
  const data = { root, required };
  try {
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`refuse to overwrite an existing policy: ${path}`);
    throw err;
  }
  return { path, key, root, required };
}

export function parseArgs(argv) {
  const args = { help: false, project: undefined, commands: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--commands") args.commands = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/configure-gates.mjs --project <path> --commands '<json argv[][]>'",
      "",
      "Writes ~/.config/pi-orchestrate/projects/<sha256(real root)[:20]>.json.",
      "Example: --commands '[[\"npm\",\"run\",\"check\"]]'",
      "Refuses to overwrite an existing policy; never creates one automatically.",
    ].join("\n"),
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`configure-gates: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.project || !args.commands) {
    console.error("configure-gates: --project and --commands are required (--help for usage)");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await configureGates({ project: args.project, commandsJson: args.commands });
    console.log(`Policy written: ${result.path}`);
  } catch (err) {
    console.error(`configure-gates: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
