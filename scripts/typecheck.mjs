#!/usr/bin/env node
// Use the installed Pi declarations and managed compiler; never install an SDK
// or write generated configuration into the checkout.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiPackageJson, REDIRECTED_SPECIFIERS } from "../lib/resolve-pi.mjs";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const packageName = specifier => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

function manifestFor(require, name) {
  for (const directory of require.resolve.paths(name) ?? []) {
    const path = join(directory, name, "package.json");
    if (existsSync(path) && readJson(path).name === name) return path;
  }
  throw new Error(`${name} missing from the selected Pi SDK`);
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const condition of ["types", "import", "default", "require"]) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
}

function sdkPaths(manifest) {
  const require = createRequire(manifest), paths = {};
  for (const name of new Set(REDIRECTED_SPECIFIERS.map(packageName))) {
    const path = manifestFor(require, name), pkg = readJson(path), directory = dirname(path);
    for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
      if (!subpath.startsWith(".")) continue;
      const target = exportTarget(value);
      if (target) paths[subpath === "." ? name : `${name}/${subpath.slice(2)}`] = [join(directory, target)];
    }
    if (pkg.types) paths[name] = [join(directory, pkg.types)];
  }
  return { paths, typeRoots: [dirname(dirname(manifestFor(require, "@types/node")))], types: ["node"] };
}

export function runTypecheck({ root = fileURLToPath(new URL("..", import.meta.url)), env = process.env } = {}) {
  let temporary;
  try {
    const sdk = findPiPackageJson(env);
    if (!sdk) throw new Error("Pi SDK not found. Set PI_PACKAGE_JSON to the installed @earendil-works/pi-coding-agent/package.json");
    const compiler = env.PI_TYPESCRIPT_PACKAGE_JSON || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "npm/node_modules/typescript/package.json");
    if (!existsSync(compiler)) throw new Error("TypeScript compiler not found. Run the documented setup or set PI_TYPESCRIPT_PACKAGE_JSON to an existing typescript/package.json");
    const pkg = readJson(compiler);
    if (pkg.name !== "typescript" || !pkg.bin?.tsc) throw new Error("Expected a TypeScript package with a tsc binary");
    const executable = resolve(dirname(compiler), pkg.bin.tsc);
    if (!existsSync(executable)) throw new Error(`TypeScript compiler binary missing: ${executable}`);
    const compilerOptions = sdkPaths(sdk);
    temporary = mkdtempSync(join(env.TMPDIR || tmpdir(), "pi-typecheck-"));
    const config = join(temporary, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ extends: resolve(root, "tsconfig.json"), compilerOptions }), { mode: 0o600 });
    console.log(`typecheck: TypeScript ${pkg.version}; Pi ${readJson(sdk).version}; ${sdk}`);
    const result = spawnSync(process.execPath, [executable, "--project", config, "--pretty", "false"], { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) console.error(`typecheck: compiler terminated by ${result.signal}`);
    return result.status ?? 1;
  } catch (error) {
    console.error(`typecheck: ${error.message}`);
    return 1;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTypecheck();
}
