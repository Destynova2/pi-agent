// Static bootstrap for this repo's tests.
//
// Contract: loaded via `node --import ./tests/resolve-pi.mjs <test files...>`. This repo
// is a pi *configuration* (extensions/agents/lib), not the Pi package itself: some
// modules it imports at runtime (not just in `import type`, stripped by Node's native
// TypeScript stripping) live in the real Pi install, not in this repo's node_modules/
// (there isn't one, deliberately -- see package.json). This file redirects this small
// set of "bare" specifiers to the modules shipped with the Pi install found on
// PATH (or explicitly designated by PI_PACKAGE_JSON), using exclusively the synchronous
// hooks of `node:module` (`registerHooks`, same thread): no `eval`, no `data:`
// URL, no dynamic `import()` of generated code, no temporary symlink. The content
// of this file is fixed, it never depends on the environment when written to disk.
//
// Worker C (extensions/graphify, extensions/orchestrate): stop implementing your own
// ad hoc redirection (e.g. a `register()` hook with a generated `data:` URL) in test
// files; load this file via `--import` instead (scripts/test.mjs already does it for the
// full repo suite). It exports `piPackageJson` and `redirectedSpecifiers` if you
// need to inspect what was resolved.
import { createRequire, registerHooks } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Expected name of the found package.json: prevents a PI_PACKAGE_JSON (or a `pi` executable on
// PATH) pointing to an arbitrary package.json from silently redirecting these imports.
export const EXPECTED_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// Only the "bare" specifiers actually imported (outside `import type`) by this repo's code
// and absent from its own npm dependencies: they live in the installed Pi package.
export const REDIRECTED_SPECIFIERS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
];

function readValidPackageJson(path, expectedName = EXPECTED_PACKAGE_NAME) {
  if (!existsSync(path)) return undefined;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return pkg && pkg.name === expectedName ? path : undefined;
}

/** Locates the real Pi install's package.json, without ever executing it. */
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
 * Resolves the Pi package's own main entry from its package.json (exports["."] then
 * main). Node does not always allow a package to resolve itself by its own name via
 * `require.resolve` (self-reference); its manifest is therefore read directly instead of
 * relying on that mechanism.
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
  if (typeof rel !== "string") rel = pkg.main;
  if (typeof rel !== "string" || !rel) return undefined;
  const entry = join(dirname(pkgJsonPath), rel);
  return existsSync(entry) ? entry : undefined;
}

/**
 * Registers a synchronous resolution hook (same thread, no worker, no generated
 * source) that redirects only REDIRECTED_SPECIFIERS to the modules resolved from
 * `pkgJsonPath`. Specifiers that cannot be resolved (dependency absent from this Pi
 * install) are simply left to Node's normal resolution.
 */
export function resolvePiDependency(pkgJsonPath, specifier) {
  if (!REDIRECTED_SPECIFIERS.includes(specifier)) return undefined;
  const req = createRequire(pkgJsonPath);
  // Prefer the real dependency's ESM entry over require conditions or a previously registered hook.
  for (const dir of req.resolve.paths(specifier) ?? []) {
    const candidate = join(dir, specifier, "package.json");
    if (!existsSync(candidate)) continue;
    const manifest = readValidPackageJson(candidate, specifier);
    return manifest ? resolveSelfEntry(manifest) : undefined;
  }
  return undefined;
}

function registerRedirect(pkgJsonPath) {
  const map = new Map();
  const selfEntry = resolveSelfEntry(pkgJsonPath);
  if (selfEntry) map.set(EXPECTED_PACKAGE_NAME, pathToFileURL(selfEntry).href);
  for (const specifier of REDIRECTED_SPECIFIERS) {
    if (specifier === EXPECTED_PACKAGE_NAME) continue;
    const entry = resolvePiDependency(pkgJsonPath, specifier);
    if (entry) map.set(specifier, pathToFileURL(entry).href);
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
