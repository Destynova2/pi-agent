#!/usr/bin/env node
// Lance les tests `node:test` du dépôt (*.test.ts et *.test.mjs), hors répertoires vendorisés.
// Par défaut : suite standard (fichiers *.integration.test.* exclus). `--integration` : lance
// la suite ENTIÈRE (rien n'est exclu) avec PI_TEST_INTEGRATION=1, qui transforme chaque skip
// explicite pour dépendance externe absente (git/jj/graphify/Pi installé...) en échec dur, puis
// exécute en plus `python3 -m unittest test_gates` (gates/pi-orchestrate) si python3 est
// disponible. Jamais de succès fictif : une dépendance manquante fait échouer, pas passer.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commandExists } from "./lib.mjs";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "bin", "git", "npm", "sessions", ".agent", "skills"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = resolve(SCRIPT_DIR, "..", "tests", "resolve-pi.mjs");
const GATES_TEST_SCRIPT = resolve(SCRIPT_DIR, "..", "gates", "pi-orchestrate", "test_gates.py");

/**
 * `all: true` ignore la distinction standard/intégration et renvoie tous les fichiers de test :
 * utilisé par `--integration`, qui doit exécuter la suite entière, pas seulement les fichiers
 * nommés `*.integration.test.*`.
 */
export function collectTests(root, { integration = false, all = false } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.test\.(ts|mjs)$/.test(entry.name)) continue;
      const isIntegration = entry.name.includes(".integration.test.");
      if (all || (integration ? isIntegration : !isIntegration)) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Le bootstrap (redirection des imports vers l'installation Pi r\u00e9elle) n'a de sens que pour ce
 * d\u00e9p\u00f4t r\u00e9el : une suite point\u00e9e sur un r\u00e9pertoire fixture (--dir, utilis\u00e9 par les tests du
 * runner lui-m\u00eame) ne doit pas le charger sans qu'on le demande explicitement (--bootstrap).
 */
export function shouldBootstrap({ dir, bootstrap = false } = {}) {
  return dir === undefined || bootstrap;
}

function parseArgs(argv) {
  const out = { integration: false, dir: undefined, bootstrap: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--integration") out.integration = true;
    else if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--bootstrap") out.bootstrap = true;
    else throw new Error(`option inconnue : ${arg}`);
  }
  return out;
}

/**
 * Exécute `python3 -m unittest test_gates` (gates/pi-orchestrate/test_gates.py). Ignoré
 * explicitement (avec un message, pas un succès silencieux) si python3 ou le script sont
 * absents ; sinon exécuté pour de vrai, y compris ses propres échecs.
 */
function runPythonGates(env) {
  if (!existsSync(GATES_TEST_SCRIPT)) {
    console.log("test: gates/pi-orchestrate/test_gates.py absent, ignoré explicitement");
    return 0;
  }
  if (!commandExists("python3", env)) {
    console.log("test: python3 absent, gates/pi-orchestrate/test_gates.py ignoré explicitement");
    return 0;
  }
  console.log("test: python3 -m unittest test_gates (gates/pi-orchestrate)");
  const res = spawnSync("python3", ["-m", "unittest", "test_gates", "-v"], {
    cwd: dirname(GATES_TEST_SCRIPT),
    env,
    stdio: "inherit",
  });
  return res.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.dir ?? fileURLToPath(new URL("..", import.meta.url)));
  const files = collectTests(root, { all: args.integration });
  if (files.length === 0) {
    console.log(args.integration ? "test: aucun test trouvé pour la suite d'intégration" : "test: aucun test trouvé");
    process.exitCode = 0;
    return;
  }

  const useBootstrap = shouldBootstrap(args) && existsSync(BOOTSTRAP_PATH);

  console.log(`test: ${files.length} fichier(s)${args.integration ? " (suite complète, PI_TEST_INTEGRATION=1)" : ""}`);
  const nodeArgs = ["--test"];
  if (useBootstrap) nodeArgs.push("--import", BOOTSTRAP_PATH);
  nodeArgs.push(...files);

  const env = args.integration ? { ...process.env, PI_TEST_INTEGRATION: "1" } : process.env;
  const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env });
  let exitCode = result.status ?? 1;

  if (args.integration) {
    const gatesStatus = runPythonGates(env);
    if (gatesStatus !== 0) exitCode = exitCode === 0 ? gatesStatus : exitCode;
  }

  process.exitCode = exitCode;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
