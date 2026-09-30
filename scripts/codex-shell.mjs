#!/usr/bin/env node
// Pi's shellPath adapter. The existing Bash supervisor still owns process groups and logs.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function sandboxArgs(command) {
  return [
    "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write={writable_roots=[],network_access=false,exclude_tmpdir_env_var=false,exclude_slash_tmp=true}",
    "-c", "features.network_proxy=false",
    "--", "/bin/bash", "--noprofile", "--norc", "-c", command,
  ];
}

export function launch(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin") throw new Error("Codex shell sandbox currently requires macOS; no unsandboxed fallback.");
  if (argv.length !== 2 || argv[0] !== "-c") throw new Error("Codex shell expects exactly: -c <command>.");
  if (typeof process.execve !== "function") throw new Error("Codex shell requires Node with process.execve (Node >=22.19).");
  const cwd = realpathSync(process.cwd());
  const agentDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  const cache = join(homedir(), ".cache/pi-codex-sandbox");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  // Never make the launcher, its backend, or its private configuration writable to commands.
  for (const protectedPath of [agentDir, codex, realpathSync(cache)]) {
    const rel = relative(cwd, protectedPath);
    if (rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))) {
      throw new Error("Start Pi in a project directory, not an ancestor of its sandbox/configuration files.");
    }
  }
  const config = join(cache, "config");
  const scratch = join(cache, createHash("sha256").update(cwd).digest("hex"), "tmp");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  env.CODEX_HOME = config; // Do not inherit the user's Codex profiles, auth or allow rules.
  env.TMPDIR = scratch; // A private per-project temp root, not all of /tmp.
  delete env.BASH_ENV;
  delete env.ENV;
  // Replace this process: cancellation/timeout still kills the original PGID and its descendants.
  process.execve(codex, [codex, ...sandboxArgs(argv[1])], env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launch(); } catch (error) {
    console.error(`Codex sandbox: ${error.message}`);
    process.exitCode = 1;
  }
}
