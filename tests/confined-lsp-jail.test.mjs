import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  buildConfinedLspWorkerCommand,
  buildConfinedLspWorkerEnv,
  resolveConfinedLspAgentPaths,
} from "../extensions/confined-lsp/jail.ts";

const AGENT_DIR = "/Users/example/.pi/agent";
// jail.ts derives repoRoot from import.meta.url two levels up (extensions/confined-lsp/jail.ts
// -> repo root), exactly like lib/confined.ts derives its own root.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("repo-owned script paths come from this module's own location, never the agent dir", () => {
  const paths = resolveConfinedLspAgentPaths(AGENT_DIR);
  assert.equal(paths.repoRoot, REPO_ROOT);
  assert.equal(paths.workerPath, resolve(REPO_ROOT, "scripts/confined-lsp-worker.mjs"));
  assert.equal(paths.shellLauncherPath, resolve(REPO_ROOT, "scripts/codex-shell.mjs"));
  assert.equal(paths.resolvePiHookPath, resolve(REPO_ROOT, "lib/resolve-pi.mjs"));
  assert.equal(paths.piLspModuleHookPath, resolve(REPO_ROOT, "extensions/confined-lsp/pi-lsp-module-hook.mjs"));
  // Only the trusted installed dependency root is the agent dir, never repo-local.
  assert.equal(paths.agentDir, AGENT_DIR);
});

test("a custom import.meta.url still resolves relative to its own module, not the caller's", () => {
  const paths = resolveConfinedLspAgentPaths(AGENT_DIR, "file:///somewhere/else/extensions/confined-lsp/jail.ts");
  assert.equal(paths.repoRoot, "/somewhere/else/");
  assert.equal(paths.workerPath, "/somewhere/else/scripts/confined-lsp-worker.mjs");
});

test("the worker command runs under plain `node` (process.execPath), not bun", () => {
  const paths = resolveConfinedLspAgentPaths(AGENT_DIR);
  const command = buildConfinedLspWorkerCommand(paths);
  assert.equal(
    command,
    [process.execPath, "--import", paths.resolvePiHookPath, "--import", paths.piLspModuleHookPath, paths.workerPath]
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
      .join(" "),
  );
});

test("single quotes inside a path do not break out of the quoted command argument", () => {
  const weird = resolveConfinedLspAgentPaths(AGENT_DIR, "file:///Users/o'brien/repo/extensions/confined-lsp/jail.ts");
  const command = buildConfinedLspWorkerCommand(weird);
  assert.ok(command.includes("o'\\''brien"), "embedded quote must be escaped, not left to terminate the string");
});

test("worker env binds PI_CODING_AGENT_DIR to the trusted agent dir", () => {
  const env = buildConfinedLspWorkerEnv(resolveConfinedLspAgentPaths(AGENT_DIR), { PI_PACKAGE_JSON: "/untrusted/package.json" });
  assert.equal(env.PI_CODING_AGENT_DIR, AGENT_DIR);
  assert.equal(env.PI_PACKAGE_JSON, resolve(getPackageDir(), "package.json"));
});

test("worker env preserves unrelated base env entries instead of replacing the whole environment", () => {
  const env = buildConfinedLspWorkerEnv(resolveConfinedLspAgentPaths(AGENT_DIR), { PATH: "/usr/bin", CUSTOM: "1" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CUSTOM, "1");
});
