// Static Node preload hook (load with `node --import`) for the confined-lsp worker only.
//
// @ian-pascoe/pi-lsp ships source-only TypeScript under node_modules with no build step, and
// its own relative imports use compiled-looking `./foo.js` specifiers that resolve to `./foo.ts`
// siblings once published. Two things are needed to run that source under plain Node (no Bun):
//   1. map those relative `.js` specifiers back to `.ts`, and the bare package specifier/the
//      two fixed submodule aliases this worker imports, to the pinned install's `src/` files;
//   2. compile those files with the Jiti compiler already shipped by the installed Pi SDK.
//      Node 26 no longer supports transforming TypeScript parameter properties.
//
// Scope is fixed and narrow on purpose: only `@ian-pascoe/pi-lsp@0.4.4` (the version this repo
// pins and tests against) under one trusted `PI_CODING_AGENT_DIR`, and only `.ts` files that are
// already physically inside that package's own `src/` directory. No other specifier, package
// version, or path is redirected or transformed; everything else falls through to Node's normal
// resolution (including the separate `lib/resolve-pi.mjs` hook redirecting
// `@earendil-works/pi-coding-agent` and friends to the real installed Pi SDK).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { piPackageJson } from "../../lib/resolve-pi.mjs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_NAME = "@ian-pascoe/pi-lsp";
const EXPECTED_VERSION = "0.4.4";

/**
 * Fixed submodule aliases the worker and this repo's tests import by bare specifier:
 * `pi-lsp-extension` (createPiLspExtension/PiLspLifecycleController, the worker's real
 * business logic) and `lsp-tool-contract` (LspToolProviderParametersSchema, the real
 * provider-facing tool schema, used only by tests/confined-lsp-schema.test.mjs to catch a
 * silent upstream drift from extensions/confined-lsp/index.ts's hand-mirrored copy).
 */
const SUBMODULE_ALIASES = {
  "@ian-pascoe/pi-lsp/pi-lsp-extension": "pi-lsp-extension.ts",
  "@ian-pascoe/pi-lsp/lsp-tool-contract": "lsp-tool-contract.ts",
};

function readValidPackageJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    return pkg.name === EXPECTED_NAME && pkg.version === EXPECTED_VERSION ? pkg : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locates the pinned `@ian-pascoe/pi-lsp@0.4.4` package under one trusted npm root.
 *
 * Realpath'd on purpose: `PI_CODING_AGENT_DIR`/its `npm` root may itself be a symlink (tests
 * point an isolated agent dir's `npm` at the real installed one without copying it). Node's own
 * ESM resolver realpaths the files it ultimately loads, so this hook's own `srcDir` prefix
 * check in `load()` must compare against the same realpath Node will report, not the
 * (possibly symlinked) path this function was handed.
 */
export function findPinnedPiLspRoot(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) return undefined;
  const packageDir = join(agentDir, "npm/node_modules/@ian-pascoe/pi-lsp");
  const pkg = readValidPackageJson(join(packageDir, "package.json"));
  if (pkg === undefined) return undefined;
  const realPackageDir = realpathSync(packageDir);
  return { packageDir: realPackageDir, srcDir: join(realPackageDir, "src"), version: pkg.version };
}

function registerPiLspHooks(pinned) {
  if (!piPackageJson) throw new Error("Confined LSP requires the installed Pi SDK compiler");
  const { createJiti } = createRequire(piPackageJson)("jiti");
  const compiler = createJiti(import.meta.url, { fsCache: false, moduleCache: false, interopDefault: true });
  const srcDirUrl = pathToFileURL(`${pinned.srcDir}/`).href;
  const aliasUrls = new Map(
    Object.entries(SUBMODULE_ALIASES).map(([specifier, relative]) => [
      specifier,
      pathToFileURL(join(pinned.srcDir, relative)).href,
    ]),
  );
  const packageIndexUrl = pathToFileURL(join(pinned.srcDir, "index.ts")).href;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-coding-agent" && context.parentURL?.startsWith(srcDirUrl)) {
        return { url: new URL("readonly-settings.mjs", import.meta.url).href, shortCircuit: true };
      }
      if (specifier === EXPECTED_NAME) return { url: packageIndexUrl, shortCircuit: true };
      const alias = aliasUrls.get(specifier);
      if (alias !== undefined) return { url: alias, shortCircuit: true };
      // Only remap a RELATIVE sibling import made from a file already inside the pinned
      // src/ root (e.g. `./lsp-tool.js` imported by `pi-lsp-extension.ts`), and only `.js`.
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        specifier.endsWith(".js") &&
        context.parentURL?.startsWith(srcDirUrl)
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(srcDirUrl) && url.endsWith(".ts")) {
        const source = readFileSync(new URL(url), "utf8");
        const code = compiler.transform({ source, filename: fileURLToPath(url), ts: true, interopDefault: true, babel: { babelrc: false, configFile: false } });
        return { format: "commonjs", shortCircuit: true, source: code };
      }
      return nextLoad(url, context);
    },
  });
}

export const pinnedPiLspRoot = findPinnedPiLspRoot();
if (pinnedPiLspRoot !== undefined) registerPiLspHooks(pinnedPiLspRoot);
