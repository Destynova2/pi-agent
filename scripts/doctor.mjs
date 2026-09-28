#!/usr/bin/env node
// Diagnostic d'environnement pour un répertoire agent pi. Stdlib Node uniquement.
// Ne lit ni n'affiche jamais le contenu de auth.json : présence de secrets non validée ici.
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandExists } from "./lib.mjs";

export const REQUIRED_COMMANDS = ["git", "curl", "pi"];
export const OPTIONAL_COMMANDS = ["graphify", "jj", "prek", "gitleaks", "python3", "claude", "gh"];
export const BUNDLED_TOOLS = ["gates/pi-prek"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function defaultTarget(env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function checkNodeVersion() {
  let required = ">=22.19";
  try {
    const pkg = JSON.parse(await readFile(join(SCRIPT_DIR, "..", "package.json"), "utf8"));
    if (pkg.engines?.node) required = pkg.engines.node;
  } catch {
    // package.json manquant ou invalide : on garde le défaut annoncé
  }
  const match = /(\d+)\.(\d+)/.exec(required);
  const minMajor = match ? Number(match[1]) : 22;
  const minMinor = match ? Number(match[2]) : 19;
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > minMajor || (major === minMajor && minor >= minMinor);
  return { name: `node ${required}`, required: true, ok, detail: process.versions.node };
}

async function checkNodeSqlite() {
  try {
    await import("node:sqlite");
    return { name: "node:sqlite", required: true, ok: true };
  } catch (err) {
    return { name: "node:sqlite", required: true, ok: false, detail: err.message };
  }
}

async function checkBundledTool(target, relPath) {
  const p = join(target, relPath);
  try {
    await access(p, fsConstants.X_OK);
    return { name: relPath, required: false, ok: true };
  } catch {
    return { name: relPath, required: false, ok: false, detail: `absent ou non exécutable (${p})` };
  }
}

/**
 * Exécute les vérifications d'environnement. `strict: true` fait échouer aussi les
 * outils optionnels manquants ; par défaut ils ne produisent qu'un avertissement.
 */
export async function runDoctor({ target, strict = false, env = process.env } = {}) {
  const resolvedTarget = resolve(target ?? defaultTarget(env));
  const results = [];

  results.push(await checkNodeVersion());
  results.push(await checkNodeSqlite());
  for (const cmd of REQUIRED_COMMANDS) {
    results.push({ name: cmd, required: true, ok: commandExists(cmd, env) });
  }
  for (const cmd of OPTIONAL_COMMANDS) {
    results.push({ name: cmd, required: false, ok: commandExists(cmd, env) });
  }
  for (const tool of BUNDLED_TOOLS) {
    results.push(await checkBundledTool(resolvedTarget, tool));
  }

  const missingRequired = results.filter((r) => r.required && !r.ok);
  const missingOptional = results.filter((r) => !r.required && !r.ok);
  const ok = missingRequired.length === 0 && (!strict || missingOptional.length === 0);

  return { target: resolvedTarget, strict, results, missingRequired, missingOptional, ok };
}

function parseArgs(argv) {
  const out = { target: undefined, strict: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") out.target = argv[++i];
    else if (arg === "--strict") out.strict = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`option inconnue : ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/doctor.mjs [--target <chemin>] [--strict]

  --target <chemin>   Répertoire agent à diagnostiquer (défaut: $PI_CODING_AGENT_DIR ou ~/.pi/agent)
  --strict            Échoue aussi si un outil optionnel manque
`);
}

function printReport(result) {
  console.log(`doctor: cible ${result.target}`);
  for (const r of result.results) {
    const label = r.required ? "requis  " : "optionnel";
    const status = r.ok ? "ok" : "manquant";
    console.log(`  [${status === "ok" ? "OK" : "!!"}] ${label} ${r.name} : ${status}${r.detail ? ` (${r.detail})` : ""}`);
  }
  if (result.missingRequired.length > 0) {
    console.error(`doctor: outils requis manquants : ${result.missingRequired.map((r) => r.name).join(", ")}`);
  }
  if (result.missingOptional.length > 0) {
    console.log(`doctor: outils optionnels manquants : ${result.missingOptional.map((r) => r.name).join(", ")}${result.strict ? " (échec en mode --strict)" : ""}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`doctor: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  const result = await runDoctor({ target: args.target, strict: args.strict });
  printReport(result);
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
