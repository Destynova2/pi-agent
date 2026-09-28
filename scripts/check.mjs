#!/usr/bin/env node
// Vérification rapide sans dépendance nouvelle : syntaxe des .mjs (`node --check`) et
// hygiène des espaces (espace/tabulation en fin de ligne, retour à la ligne final), plus
// `git diff --check` sur l'arbre entier sauf si --skip-git-diff (utilisé par les tests).
// La tabulation d'indentation en début de ligne est un style légitime (voir
// extensions/graphify/tests/*.mjs) : seule la tabulation traînante en fin de ligne est un défaut.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "bin", "git", "npm", "sessions", ".agent", "skills"]);

export function collectMjs(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".mjs")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

export function checkWhitespace(file) {
  const content = readFileSync(file, "utf8");
  const problems = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${file}:${i + 1}: espace(s) ou tabulation(s) en fin de ligne`);
  });
  if (content.length > 0 && !content.endsWith("\n")) {
    problems.push(`${file}: pas de retour à la ligne final`);
  }
  return problems;
}

export function runCheck({ dir, skipGitDiff = false } = {}) {
  const root = dir ? resolve(dir) : fileURLToPath(new URL("..", import.meta.url));
  const files = collectMjs(root);
  const messages = [];
  let ok = true;

  for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) {
      ok = false;
      messages.push(`${file}: erreur de syntaxe\n${(res.stderr || "").trim()}`);
    }
    const problems = checkWhitespace(file);
    if (problems.length > 0) {
      ok = false;
      messages.push(...problems);
    }
  }

  if (!skipGitDiff) {
    for (const args of [["diff", "--check"], ["diff", "--cached", "--check"]]) {
      const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (res.status !== 0 && (res.stdout || "").trim()) {
        ok = false;
        messages.push((res.stdout || "").trim());
      }
    }
  }

  return { ok, files, messages };
}

function parseArgs(argv) {
  const out = { dir: undefined, skipGitDiff: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--skip-git-diff") out.skipGitDiff = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`option inconnue : ${arg}`);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log("Usage: node scripts/check.mjs [--dir <chemin>] [--skip-git-diff]");
    return;
  }
  const result = runCheck(args);
  for (const m of result.messages) console.error(m);
  console.log(`check: ${result.files.length} fichier(s) .mjs analysés${result.ok ? ", tout est propre" : ""}`);
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
