#!/usr/bin/env node
// Pi's shellPath adapter. The existing Bash supervisor still owns process groups and logs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkHosts, networkSandboxArgs, requireNetworkProxyVersion } from "./codex-network.mjs";

// Only the fixed notes worker receives these grants; ordinary Bash never does.
export function notesWritableRoots(cwd) {
  let root = realpathSync(cwd);
  try { root = realpathSync(execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()); }
  catch (error) { if (error.code === "ETIMEDOUT") throw error; }
  const local = join(root, ".agent");
  const central = join(homedir(), "workspace", "notes.db");
  const paths = [local, ...[join(local, "notes.db"), ...(existsSync(dirname(central)) ? [central] : [])].flatMap(file => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`])];
  const exclude = join(root, ".git", "info", "exclude");
  if (existsSync(dirname(exclude))) paths.push(exclude);
  for (const path of paths) {
    for (let current = path; current !== root && current !== dirname(current); current = dirname(current)) {
      let stat;
      try { stat = lstatSync(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error(`Notes storage must not contain links: ${current}`);
    }
  }
  return paths;
}

// Explicit host approval may add these roots for one process, never its parent session.
export function commandWritableRoots(paths, cwd, agentDir, protectedPaths = []) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) throw new Error("Expected 1–8 exact write paths");
  const within = (parent, path) => { const rel = relative(parent, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
  const agent = realpathSync.native(agentDir);
  const runtime = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const cache = join(homedir(), ".cache/pi-codex-sandbox");
  const backend = process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex");
  const protectedRoots = [...new Set([agent, runtime, cache, backend, process.execPath, ...protectedPaths].map(path => existsSync(path) ? realpathSync.native(path) : resolve(path)))];
  return [...new Set(paths.map(path => {
    if (typeof path !== "string" || path.length > 1024 || !isAbsolute(path) || path !== resolve(path) || /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw new Error("Write paths must be canonical absolute paths without control characters");
    for (let current = path; ; current = dirname(current)) {
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error(`Write paths cannot contain links or special files: ${current}`);
        if (realpathSync.native(current) !== current) throw new Error(`Write paths must use canonical spelling: ${current}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current === dirname(current)) break;
    }
    if (within(path, realpathSync(cwd))) throw new Error("Cannot grant the workspace or its ancestors");
    for (const root of protectedRoots) {
      if (within(root, path) || within(path, root)) throw new Error(`Cannot grant sandbox runtime/configuration storage: ${path}`);
    }
    return path;
  }))].sort();
}

export function sandboxArgs(command, writableRoots = []) {
  return [
    "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write={writable_roots=${JSON.stringify(writableRoots)},network_access=false,exclude_tmpdir_env_var=false,exclude_slash_tmp=true}`,
    "-c", "features.network_proxy=false",
    "--", "/bin/bash", "--noprofile", "--norc", "-c", command,
  ];
}

export function launch(argv = process.argv.slice(2)) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Codex shell sandbox requires macOS or Linux; no unsandboxed fallback.");
  let requestedRoots;
  if (argv[0] === "--write-roots") {
    if (!argv[1] || Buffer.byteLength(argv[1]) > 16384) throw new Error("Invalid write-roots request");
    requestedRoots = JSON.parse(argv[1]);
    argv = argv.slice(2);
    if (!Array.isArray(requestedRoots)) throw new Error("Expected write-roots array");
  }
  const service = requestedRoots === undefined && (argv[0] === "--notes" || argv[0] === "--offline") ? argv[0].slice(2) : undefined;
  if (service) argv = argv.slice(1);
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
  const allowedHosts = service ? [] : networkHosts(agentDir, cwd, env.PI_CODEX_NETWORK_GRANTS);
  if (allowedHosts.length) requireNetworkProxyVersion(execFileSync(codex, ["--version"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 65536 }));
  const roots = requestedRoots === undefined ? (service === "notes" ? notesWritableRoots(cwd) : [])
    : commandWritableRoots(requestedRoots, cwd, process.env.PI_CODING_AGENT_DIR ?? agentDir, [codex]);
  const args = allowedHosts.length ? networkSandboxArgs(argv[1], cwd, scratch, allowedHosts, roots) : sandboxArgs(argv[1], roots);
  delete env.PI_CODEX_NETWORK_GRANTS; // Grants are broker state, not a child-controlled channel.
  // Node captures stdio with Unix sockets; Linux seccomp denies libuv's socket
  // inspection. Fixed cat relays supply real pipes without relaxing the sandbox.
  // The command stays an argv value to Codex, never evaluated by this outer shell.
  if (process.platform === "linux") {
    process.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-c",
      'set -o pipefail; "$@" < <(/bin/cat) 2> >(/bin/cat >&2) | /bin/cat',
      "pi-codex-sandbox", codex, ...args], env);
  } else {
    // Keep the original PGID for cancellation/timeout on both platforms.
    process.execve(codex, [codex, ...args], env);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { launch(); } catch (error) {
    console.error(`Codex sandbox: ${error.message}`);
    process.exitCode = 1;
  }
}
