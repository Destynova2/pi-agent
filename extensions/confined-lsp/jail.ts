// Pure path/argv composition for the confined Pi LSP worker. No spawning, no I/O here: keeps
// the jail boundary testable without a real sandbox or language server.
//
// Two distinct directories are involved, and they must never be conflated (see
// tests/confined-lsp-worker.test.mjs's own REPO_DIR/AGENT_DIR split): `repoRoot` is where THIS
// extension and its worker script live, derived from `import.meta.url` exactly like
// lib/confined.ts derives it -- scripts/confined-lsp-worker.mjs, scripts/codex-shell.mjs, and
// the two static `node --import` preload hooks are always read from there, never from the
// installed agent directory. `agentDir` (Pi's own `getAgentDir()`) is only where the
// already-installed @ian-pascoe/pi-lsp 0.4.4 and its settings/enablement files live; the worker
// resolves that root for itself from `PI_CODING_AGENT_DIR` at import time (pi-lsp-module-hook.mjs)
// and at "session_start" time (SettingsManager.create), never from a path baked in here.
//
// No Bun dependency: the worker runs under plain `node`. Node's own `node:module`
// `stripTypeScriptTypes` (registered by pi-lsp-module-hook.mjs) loads @ian-pascoe/pi-lsp's
// source-only TypeScript; Node's node_modules type-stripping restriction only blocks its
// *built-in* loader for `.ts` files under node_modules, not a module customization hook that
// strips and returns source itself.
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ConfinedLspAgentPaths {
  readonly agentDir: string;
  readonly repoRoot: string;
  readonly workerPath: string;
  readonly shellLauncherPath: string;
  readonly resolvePiHookPath: string;
  readonly piLspModuleHookPath: string;
}

/** Resolve every jail-relevant path. `repoRoot` comes from this module's own location. */
export function resolveConfinedLspAgentPaths(
  agentDir: string,
  importMetaUrl: string = import.meta.url,
): ConfinedLspAgentPaths {
  const repoRoot = fileURLToPath(new URL("../../", importMetaUrl));
  return {
    agentDir,
    repoRoot,
    workerPath: join(repoRoot, "scripts/confined-lsp-worker.mjs"),
    shellLauncherPath: join(repoRoot, "scripts/codex-shell.mjs"),
    resolvePiHookPath: join(repoRoot, "lib/resolve-pi.mjs"),
    piLspModuleHookPath: join(repoRoot, "extensions/confined-lsp/pi-lsp-module-hook.mjs"),
  };
}

function quoteShellSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The exact `node --import ... --import ... <worker>` command string run via `bash -c`. */
export function buildConfinedLspWorkerCommand(paths: ConfinedLspAgentPaths): string {
  return [
    process.execPath,
    "--import",
    paths.resolvePiHookPath,
    "--import",
    paths.piLspModuleHookPath,
    paths.workerPath,
  ]
    .map(quoteShellSingle)
    .join(" ");
}

/** Env the parent must set before spawning `codex-shell.mjs --offline -c <command>` for the worker. */
export function buildConfinedLspWorkerEnv(
  paths: ConfinedLspAgentPaths,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_PACKAGE_JSON: join(getPackageDir(), "package.json"),
  };
}
