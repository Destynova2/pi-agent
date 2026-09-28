#!/usr/bin/env node
// Installeur idempotent de la configuration pi-agent vers un répertoire cible.
// Stdlib Node uniquement. Voir README.md et docs/configuration.md (pi) pour le contrat.
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isSubPath, isSymlink, pathExists } from "./lib.mjs";

export const MANAGED_DIRS = ["agents", "extensions", "lib", "gates"];
export const MANAGED_FILES = ["keybindings.json"];
export const MANAGED_ENTRIES = [...MANAGED_DIRS, ...MANAGED_FILES, "settings.json"];

const DEFAULT_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultTarget(env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Résout un chemin vers sa forme canonique (liens symboliques traversés) même s'il n'existe
 * pas encore : on remonte jusqu'au premier ancêtre existant, on le résout avec `realpath`, puis
 * on rajoute le suffixe inexistant tel quel. Deux chemins désignant le même emplacement via des
 * alias légitimes (ex. macOS `/tmp` -> `/private/tmp`) deviennent ainsi comparables, sans pour
 * autant rejeter tout chemin qui contiendrait `/tmp`.
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

/** Liste tous les liens symboliques (à toute profondeur) sous `root`, sans descendre dedans. */
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
 * Vérifie, avant toute mutation, que source et cible sont des emplacements distincts et non
 * imbriqués (comparaison sur chemins canoniques : les liens symboliques du système comme
 * `/tmp` <-> `/private/tmp` sur macOS sont donc résolus vers le même emplacement plutôt que
 * rejetés en bloc), que la cible elle-même n'est pas un lien symbolique, et qu'aucune ressource
 * gérée (source ou cible, entrée elle-même et tout son contenu) n'en contient un : un lien
 * symbolique dans un répertoire géré permettrait d'écrire hors de la cible pendant la
 * synchronisation.
 */
async function assertSafeTarget(sourceRoot, target) {
  if (await isSymlink(target)) {
    throw new Error(`refus : la cible est un lien symbolique (${target})`);
  }

  const sourceCanonical = await canonicalPath(sourceRoot);
  const targetCanonical = await canonicalPath(target);
  if (sourceCanonical === targetCanonical) {
    throw new Error(`refus : cible identique à la source (${target}). Ce dépôt reste la source, pas le stockage installé.`);
  }
  if (isSubPath(sourceCanonical, targetCanonical) || isSubPath(targetCanonical, sourceCanonical)) {
    throw new Error(`refus : source et cible se chevauchent (${sourceRoot} / ${target})`);
  }

  const symlinkEntries = [];
  for (const entry of MANAGED_ENTRIES) {
    symlinkEntries.push(...(await scanSymlinks(join(sourceRoot, entry))));
    symlinkEntries.push(...(await scanSymlinks(join(target, entry))));
  }
  if (symlinkEntries.length > 0) {
    throw new Error(
      `refus : lien(s) symbolique(s) détecté(s) dans des ressources gérées, risque d'écriture hors cible :\n${symlinkEntries.join("\n")}`,
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
    await cp(join(target, entry), join(backupDir, entry), { recursive: true });
  }
  return backupDir;
}

/** Liste les fichiers réguliers sous `dir` (chemins relatifs). Refuse tout lien symbolique. */
async function listFiles(dir) {
  const results = [];
  async function walk(current, relBase) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const rel = relBase ? join(relBase, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`refus : lien symbolique rencontré pendant la copie (${abs})`);
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
 * Copie fichier par fichier depuis `src` vers `dest`, en ne touchant que les chemins présents
 * dans `src`. Ne supprime jamais `dest` : tout fichier/dossier que l'utilisateur a ajouté dans
 * un répertoire géré (extension personnelle, note, etc.) et qui n'existe pas dans `src` reste
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
  await rm(dest, { force: true });
  await cp(src, dest);
  return true;
}

function validateSettingsSchema(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`refus : ${label} n'est pas un objet JSON valide (${label})`);
  }
  if ("packages" in value) {
    const ok = Array.isArray(value.packages) && value.packages.every((p) => typeof p === "string");
    if (!ok) throw new Error(`refus : ${label}.packages doit être un tableau de chaînes`);
  }
}

/** Lit et valide un settings.json minimal, avant toute mutation. Absent => objet vide. */
async function readSettings(path, label) {
  if (!(await pathExists(path))) return {};
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`refus : ${label} JSON invalide (${path}) : ${err.message}`);
  }
  validateSettingsSchema(parsed, label);
  return parsed;
}

/**
 * Identité d'une entrée `packages` sans son marqueur de version final (`@version` ou
 * `@sha`), pour pouvoir remplacer une ancienne version par la nouvelle sans dupliquer.
 * Un `@` qui suit immédiatement `/` ou `:` fait partie d'un scope npm (`npm:@scope/nom`),
 * pas d'un marqueur de version : il n'est pas retiré.
 */
export function packageIdentity(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return spec;
  const before = spec[at - 1];
  if (before === "/" || before === ":") return spec;
  return spec.slice(0, at);
}

/**
 * Préserve les préférences déjà présentes en cible (et les paquets personnels qu'elle a
 * ajoutés). Seuls les paquets gérés par la source (même identité) sont remplacés par la
 * version de la source ; les paquets personnels de la cible sans équivalent en source sont
 * conservés tels quels.
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
  for (const source of packages) {
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
 * Installe la configuration depuis `sourceRoot` (le dépôt courant par défaut) vers `target`.
 * Ne touche jamais auth.json, sessions/, models-store.json, trust.json ni tout fichier hors
 * MANAGED_ENTRIES : ils restent la responsabilité de Pi et de l'utilisateur.
 *
 * Ordre : validation intégrale (chemin cible, sécurité source/cible, schéma JSON) avant la
 * moindre mutation, puis sauvegarde, puis copie, pour ne jamais laisser une entrée invalide
 * toucher les ressources déjà installées.
 */
export async function runInstall({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  target,
  noPackages = false,
  env = process.env,
} = {}) {
  if (target !== undefined && (typeof target !== "string" || target.trim() === "")) {
    throw new Error("refus : --target doit être un chemin non vide");
  }
  sourceRoot = resolve(sourceRoot);
  const resolvedTarget = resolve(target ?? defaultTarget(env));

  await assertSafeTarget(sourceRoot, resolvedTarget);

  const sourceSettings = await readSettings(join(sourceRoot, "settings.json"), "settings.json source");
  const targetSettings = await readSettings(join(resolvedTarget, "settings.json"), "settings.json cible");
  const mergedSettings = mergeSettings(sourceSettings, targetSettings);

  await mkdir(resolvedTarget, { recursive: true });
  const backupDir = await backupExisting(resolvedTarget, MANAGED_ENTRIES);

  try {
    const syncedDirs = [];
    for (const dir of MANAGED_DIRS) {
      if (await syncDir(join(sourceRoot, dir), join(resolvedTarget, dir))) syncedDirs.push(dir);
    }
    const syncedFiles = [];
    for (const file of MANAGED_FILES) {
      if (await syncFile(join(sourceRoot, file), join(resolvedTarget, file))) syncedFiles.push(file);
    }

    await writeFile(join(resolvedTarget, "settings.json"), `${JSON.stringify(mergedSettings, null, 2)}\n`);

    let installed = [];
    let packageFailures = [];
    if (!noPackages) {
      ({ installed, failures: packageFailures } = installPackages(sourceSettings.packages ?? [], resolvedTarget, env));
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
    // La sauvegarde a déjà eu lieu : on la signale même si la suite échoue, pour que
    // l'utilisateur sache où retrouver son état précédent.
    err.backupDir = backupDir;
    throw err;
  }
}

function parseArgs(argv) {
  const out = { target: undefined, noPackages: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      if (i + 1 >= argv.length) throw new Error("--target requiert un chemin");
      out.target = argv[++i];
    } else if (arg === "--no-packages") out.noPackages = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`option inconnue : ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/install.mjs [--target <chemin>] [--no-packages]

  --target <chemin>   Répertoire agent cible (défaut: $PI_CODING_AGENT_DIR ou ~/.pi/agent)
  --no-packages       Ne pas invoquer \`pi install\` (mode hors-ligne)
`);
}

function printSummary(result) {
  console.log(`install: cible ${result.target}`);
  if (result.backupDir) console.log(`install: sauvegarde préalable dans ${result.backupDir}`);
  console.log(`install: répertoires synchronisés : ${result.syncedDirs.join(", ") || "(aucun)"}`);
  console.log(`install: fichiers synchronisés : ${result.syncedFiles.join(", ") || "(aucun)"}`);
  if (result.skippedPackages) {
    console.log("install: paquets ignorés (--no-packages)");
  } else if (result.packageFailures.length > 0) {
    console.log(`install: paquets installés : ${result.installedPackages.join(", ") || "(aucun)"}`);
    for (const failure of result.packageFailures) {
      console.error(`install: échec paquet ${failure.source} : ${failure.message}`);
    }
    console.error("install: terminé avec des échecs de paquets, ne pas considérer comme un succès complet");
  } else {
    console.log(`install: paquets installés : ${result.installedPackages.join(", ") || "(aucun)"}`);
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
    if (err.backupDir) console.error(`install: sauvegarde préalable conservée dans ${err.backupDir} malgré l'échec`);
    console.error(`install: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
