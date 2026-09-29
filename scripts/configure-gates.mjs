#!/usr/bin/env node
// Initialise explicitement la politique de gates d'un projet, sans jamais deviner les
// commandes requises ni affaiblir gates.py (gates/pi-orchestrate/gates.py). Stdlib only.
//
// Écrit ~/.config/pi-orchestrate/projects/<sha256(root réel)[:20]>.json avec
// { root, required }. Refuse d'écraser une politique existante (fichier ou symlink,
// y compris un symlink sur un des dossiers parents gérés).
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** sha256 hex tronqué du chemin racine réel, identique à key() dans gates.py. */
export function policyKey(realRoot) {
  return createHash("sha256").update(realRoot).digest("hex").slice(0, 20);
}

/** Résout le chemin réel (symlinks compris) d'un répertoire de projet existant. */
export async function resolveProjectRoot(projectPath) {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new Error("--project est requis et doit être un chemin non vide");
  }
  let real;
  try {
    real = await realpath(projectPath);
  } catch (err) {
    throw new Error(`--project introuvable : ${projectPath} (${err.code ?? err.message})`);
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new Error(`--project doit être un répertoire : ${real}`);
  return real;
}

/** Valide un JSON de commandes : tableau non vide d'argv (tableaux de chaînes non vides). */
export function parseRequiredCommands(json) {
  let commands;
  try {
    commands = JSON.parse(json);
  } catch (err) {
    throw new Error(`--commands n'est pas un JSON valide : ${err.message}`);
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("--commands doit être un tableau JSON non vide de commandes argv");
  }
  commands.forEach((argv, i) => {
    const bad =
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((s) => typeof s === "string" && s.length > 0);
    if (bad) {
      throw new Error(`--commands[${i}] doit être un tableau non vide de chaînes non vides`);
    }
  });
  return commands;
}

/** Refuse tout lien symbolique sur un chemin existant. */
async function refuseSymlink(path) {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null; // n'existe pas
  }
  if (st.isSymbolicLink()) throw new Error(`refus : ${path} est un lien symbolique`);
  return st;
}

/** Crée (mode 0700) ~/.config/pi-orchestrate/projects sans jamais suivre un symlink parent. */
async function securedProjectsDir(homeDir) {
  await refuseSymlink(homeDir);
  let cur = homeDir;
  for (const seg of [".config", "pi-orchestrate", "projects"]) {
    cur = join(cur, seg);
    const st = await refuseSymlink(cur);
    if (st) {
      if (!st.isDirectory()) throw new Error(`refus : ${cur} n'est pas un répertoire`);
    } else {
      await mkdir(cur, { mode: 0o700 });
    }
  }
  return cur;
}

/**
 * Écrit la politique de gates pour un projet. N'écrase jamais un fichier existant
 * (création exclusive, refuse aussi tout symlink en place ou sur un dossier parent géré).
 */
export async function configureGates({ project, commandsJson, homeDir = homedir() }) {
  const root = await resolveProjectRoot(project);
  const required = parseRequiredCommands(commandsJson);
  const projectsDir = await securedProjectsDir(homeDir);
  const key = policyKey(root);
  const path = join(projectsDir, `${key}.json`);
  await refuseSymlink(path);
  const existing = await stat(path).catch(() => null);
  if (existing) throw new Error(`refus d'écraser une politique existante : ${path}`);
  const data = { root, required };
  try {
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`refus d'écraser une politique existante : ${path}`);
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
    else throw new Error(`argument inconnu : ${a}`);
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/configure-gates.mjs --project <path> --commands '<json argv[][]>'",
      "",
      "Écrit ~/.config/pi-orchestrate/projects/<sha256(root réel)[:20]>.json.",
      "Exemple : --commands '[[\"npm\",\"run\",\"check\"]]'",
      "Refuse d'écraser une politique existante ; jamais de création automatique.",
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
    console.error("configure-gates: --project et --commands sont requis (--help pour l'usage)");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await configureGates({ project: args.project, commandsJson: args.commands });
    console.log(`Politique écrite : ${result.path}`);
  } catch (err) {
    console.error(`configure-gates: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
