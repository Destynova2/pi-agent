#!/usr/bin/env node
// Pi's shellPath adapter. The existing Bash supervisor still owns process groups and logs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confinedCommand, networkHosts, networkSandboxArgs, publicWebUrl, readNetworkPolicy, requireNetworkProxyVersion, sandboxFilesystem } from "./codex-network.mjs";
import { metalBackend } from "./metal-backend.mjs";

// Own both process substitutions in the supervisor, not a pipeline subshell.
// Reap stderr after EOF and stop stdin if the command exits without consuming it.
export const LINUX_STDIO_RELAY = `set -o pipefail
exec 3< <(/bin/cat)
input_pid=$!
exec 4> >(/bin/cat >&2)
error_pid=$!
"$@" <&3 2>&4 3<&- 4>&- | /bin/cat 3<&- 4>&-
status=$?
exec 3<&- 4>&-
kill "$input_pid" 2>/dev/null || :
wait "$input_pid" 2>/dev/null || :
wait "$error_pid"
exit "$status"`;

export function sandboxBackend(env = process.env) {
  if (env.PI_CODEX_SANDBOX_BIN) return env.PI_CODEX_SANDBOX_BIN;
  const home = env.HOME ?? homedir();
  const patched = join(home, ".local/share/pi-codex/0.155.1-file-roots/codex");
  return process.platform === "linux" && existsSync(patched) ? patched : join(home, ".local/bin/codex");
}

// Only the fixed notes worker receives these grants; ordinary Bash never does.
export function notesWritableRoots(cwd) {
  let root = realpathSync(cwd);
  try { root = realpathSync(execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()); }
  catch (error) { if (error.code === "ETIMEDOUT") throw error; }
  const local = join(root, ".agent");
  const central = join(homedir(), "workspace", "notes.db");
  // Grant the local directory once; mounting its SQLite files separately prevents
  // SQLite from rotating them. The central directory must remain read-only.
  const centralFiles = existsSync(dirname(central)) ? [central, `${central}-wal`, `${central}-shm`, `${central}-journal`] : [];
  const paths = [local, ...centralFiles];
  const exclude = join(root, ".git", "info", "exclude");
  if (existsSync(dirname(exclude))) paths.push(exclude);
  const localDb = join(local, "notes.db");
  for (const path of [...paths, localDb, `${localDb}-wal`, `${localDb}-shm`, `${localDb}-journal`]) {
    for (let current = path; current !== root && current !== dirname(current); current = dirname(current)) {
      let stat;
      try { stat = lstatSync(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error(`Notes storage must not contain links: ${current}`);
    }
  }
  // Linux bind mounts need existing targets. Create only these fixed storage
  // paths, after checking all of them; never grant their parent directories.
  mkdirSync(local, { recursive: true, mode: 0o700 });
  for (const file of [...centralFiles, ...(paths.includes(exclude) ? [exclude] : [])]) {
    const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Notes storage must be a regular unlinked file: ${file}`);
    } finally { closeSync(fd); }
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
  const backend = sandboxBackend();
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

export function sandboxArgs(command, cwd, scratch, writableRoots = [], readOnlyRoots = []) {
  return [
    "sandbox", "-C", cwd, "-P", "pi", "--include-managed-config",
    "-c", "features.network_proxy=false",
    "-c", `permissions={pi={extends=":workspace",${sandboxFilesystem(scratch, writableRoots, readOnlyRoots)},network={enabled=false}}}`,
    ...confinedCommand(command),
  ];
}

export function launch(argv = process.argv.slice(2)) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Codex shell sandbox requires macOS or Linux; no unsandboxed fallback.");
  let webUrl;
  if (argv[0] === "--web-url") {
    if (argv.length !== 2) throw new Error("Exact web read expects only --web-url <url>");
    webUrl = publicWebUrl(argv[1]);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const worker = fileURLToPath(new URL("./web-read-worker.mjs", import.meta.url));
    argv = ["-c", [process.execPath, worker, webUrl].map(quote).join(" ")];
  }
  let metalDigest;
  if (argv[0] === "--metal") {
    metalDigest = argv[1];
    if (!/^[a-f0-9]{64}$/.test(metalDigest ?? "")) throw new Error("Metal requires the exact approved backend digest");
    argv = argv.slice(2);
  }
  let requestedRoots;
  if (argv[0] === "--write-roots") {
    if (!argv[1] || Buffer.byteLength(argv[1]) > 16384) throw new Error("Invalid write-roots request");
    requestedRoots = JSON.parse(argv[1]);
    argv = argv.slice(2);
    if (!Array.isArray(requestedRoots)) throw new Error("Expected write-roots array");
  }
  let readOnlyRoots = [];
  if (argv[0] === "--read-roots") {
    if (!argv[1] || Buffer.byteLength(argv[1]) > 16384) throw new Error("Invalid read-roots request");
    readOnlyRoots = JSON.parse(argv[1]);
    if (!Array.isArray(readOnlyRoots) || readOnlyRoots.length > 16 || readOnlyRoots.some(path => typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || /[\u0000-\u001f]/u.test(path))) throw new Error("Expected narrow absolute read-only paths");
    argv = argv.slice(2);
  }
  const service = !metalDigest && (argv[0] === "--offline" || (requestedRoots === undefined && argv[0] === "--notes")) ? argv[0].slice(2) : undefined;
  if (service) argv = argv.slice(1);
  if (argv.length !== 2 || argv[0] !== "-c") throw new Error("Codex shell expects exactly: -c <command>.");
  if (typeof process.execve !== "function") throw new Error("Codex shell requires Node with process.execve (Node >=22.19).");
  const cwd = realpathSync(process.cwd());
  const runtime = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const agentDir = realpathSync(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const metal = metalDigest ? metalBackend(agentDir) : undefined;
  if (metal && metal.sha256 !== metalDigest) throw new Error("Metal backend changed after approval");
  const codex = metal?.binary ?? realpathSync(sandboxBackend());
  const cache = join(homedir(), ".cache/pi-codex-sandbox");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  // Never make the launcher, its backend, or its private configuration writable to commands.
  for (const protectedPath of [agentDir, runtime, codex, realpathSync(cache)]) {
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
  env.PI_CODING_AGENT_DIR = agentDir;
  env.CODEX_HOME = config; // Do not inherit the user's Codex profiles, auth or allow rules.
  env.TMPDIR = scratch; // A private per-project temp root, not all of /tmp.
  delete env.BASH_ENV;
  delete env.ENV;
  const webHost = webUrl && new URL(webUrl).hostname;
  if (webHost && readNetworkPolicy(agentDir).deny.includes(webHost)) throw new Error("WEB_NETWORK_DENIED: destination explicitly denied by network-policy.json");
  // The fixed reader gets only its exact destination, never the baseline/session hosts.
  const allowedHosts = webHost ? [webHost] : service ? [] : networkHosts(agentDir, cwd, env.PI_CODEX_NETWORK_GRANTS);
  if (allowedHosts.length) requireNetworkProxyVersion(execFileSync(codex, ["--version"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 65536 }));
  const roots = requestedRoots === undefined ? (service === "notes" ? notesWritableRoots(cwd) : [])
    : commandWritableRoots(requestedRoots, cwd, process.env.PI_CODING_AGENT_DIR ?? agentDir, [codex]);
  const args = allowedHosts.length ? networkSandboxArgs(argv[1], cwd, scratch, allowedHosts, roots, readOnlyRoots) : sandboxArgs(argv[1], cwd, scratch, roots, readOnlyRoots);
  delete env.PI_CONFINED; // Only the command inside Codex sets the handoff marker.
  if (metal) args.splice(1, 0, "--allow-metal");
  delete env.PI_CODEX_NETWORK_GRANTS; // Grants are broker state, not a child-controlled channel.
  // Node captures stdio with Unix sockets; Linux seccomp denies libuv's socket
  // inspection. Fixed cat relays supply real pipes without relaxing the sandbox.
  // The command stays an argv value to Codex, never evaluated by this outer shell.
  if (process.platform === "linux") {
    process.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-c",
      LINUX_STDIO_RELAY,
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
