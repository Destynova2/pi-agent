// Bootstrap statique pour les tests de ce dépôt.
//
// Contrat : chargé via `node --import ./tests/resolve-pi.mjs <fichiers de test...>`. Ce dépôt
// est une *configuration* pi (extensions/agents/lib), pas le paquet Pi lui-même : certains
// modules qu'il importe à l'exécution (pas seulement en `import type`, effacé par le décapage
// TypeScript natif de Node) vivent dans l'installation Pi réelle, pas dans node_modules/ de ce
// dépôt (il n'y en a pas, volontairement — voir package.json). Ce fichier redirige ce petit
// ensemble de specifiers "bare" vers les modules livrés avec l'installation Pi trouvée sur
// PATH (ou désignée explicitement par PI_PACKAGE_JSON), en utilisant exclusivement les hooks
// synchrones de `node:module` (`registerHooks`, même thread) : pas de `eval`, pas de `data:`
// URL, pas d'`import()` dynamique de code généré, pas de lien symbolique temporaire. Le contenu
// de ce fichier est fixe, il ne dépend jamais de l'environnement au moment d'écrire sur disque.
//
// Worker C (extensions/graphify, extensions/orchestrate) : n'implémentez plus votre propre
// redirection ad hoc (ex. hook `register()` avec une `data:` URL générée) dans les fichiers de
// test ; chargez ce fichier via `--import` à la place (scripts/test.mjs le fait déjà pour la
// suite complète du dépôt). Il exporte `piPackageJson` et `redirectedSpecifiers` si vous avez
// besoin d'inspecter ce qui a été résolu.
import { createRequire, registerHooks } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Nom attendu du package.json trouvé : évite qu'un PI_PACKAGE_JSON (ou un exécutable `pi` sur
// PATH) pointant vers un package.json arbitraire ne redirige silencieusement ces imports.
export const EXPECTED_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// Seuls les specifiers "bare" réellement importés (hors `import type`) par le code de ce dépôt
// et absents de ses propres dépendances npm : ils vivent dans le paquet Pi installé.
export const REDIRECTED_SPECIFIERS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
];

function readValidPackageJson(path) {
  if (!existsSync(path)) return undefined;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return pkg && pkg.name === EXPECTED_PACKAGE_NAME ? path : undefined;
}

/** Localise le package.json de l'installation Pi réelle, sans jamais l'exécuter. */
export function findPiPackageJson(env = process.env) {
  const override = env.PI_PACKAGE_JSON;
  if (override) return readValidPackageJson(override);

  const names = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  let bin;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        bin = candidate;
        break;
      }
    }
    if (bin) break;
  }
  if (!bin) return undefined;

  let dir = dirname(realpathSync(bin));
  while (true) {
    const found = readValidPackageJson(join(dir, "package.json"));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Résout l'entrée principale du paquet Pi lui-même depuis son package.json (exports["."] puis
 * main). Node ne permet pas toujours à un paquet de se résoudre par son propre nom via
 * `require.resolve` (auto-référence) ; on lit donc directement son manifeste plutôt que de
 * dépendre de ce mécanisme.
 */
function resolveSelfEntry(pkgJsonPath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  let rel;
  const dot = pkg.exports && typeof pkg.exports === "object" ? pkg.exports["."] : undefined;
  if (typeof dot === "string") rel = dot;
  else if (dot && typeof dot === "object") rel = dot.import ?? dot.default ?? dot.require;
  if (!rel) rel = pkg.main;
  if (!rel) return undefined;
  const entry = join(dirname(pkgJsonPath), rel);
  return existsSync(entry) ? entry : undefined;
}

/**
 * Enregistre un hook de résolution synchrone (même thread, pas de worker, pas de source
 * générée) qui redirige uniquement REDIRECTED_SPECIFIERS vers les modules résolus depuis
 * `pkgJsonPath`. Les specifiers non résolvables (dépendance absente de cette installation Pi)
 * sont simplement laissés à la résolution normale de Node.
 */
function registerRedirect(pkgJsonPath) {
  const req = createRequire(pkgJsonPath);
  const map = new Map();
  const selfEntry = resolveSelfEntry(pkgJsonPath);
  if (selfEntry) map.set(EXPECTED_PACKAGE_NAME, pathToFileURL(selfEntry).href);
  for (const specifier of REDIRECTED_SPECIFIERS) {
    if (specifier === EXPECTED_PACKAGE_NAME) continue;
    try {
      map.set(specifier, pathToFileURL(req.resolve(specifier)).href);
    } catch {
      // pas une dépendance de l'installation Pi trouvée : rien à rediriger pour ce specifier
    }
  }
  if (map.size === 0) return undefined;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = map.get(specifier);
      if (target) return { url: target, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  return map;
}

export const piPackageJson = findPiPackageJson();
export const redirectedSpecifiers = piPackageJson ? registerRedirect(piPackageJson) : undefined;
