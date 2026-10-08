// Git inspection stays confined. The parent archives exact, revalidated paths;
// it never executes a host Git command or recursively deletes a worktree.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runProcess } from "./process.ts";

const controls = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u;
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
const absent = (path: string) => { try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface WorktreeRequest { operation: "inspect" | "remove" | "prune"; paths?: string[]; reason: string }
export interface WorktreeEntry { path: string; metadata: string; head: string; branch: string | null; present: boolean; locked: boolean; dirty: boolean; knownRemote: boolean; files: number; stamp: string }
export interface WorktreeSnapshot { root: string; commonDir: string; identity: string; entries: WorktreeEntry[] }

export function worktreeRequest(value: unknown): WorktreeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16384) throw new Error("Worktree request must be a bounded object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["operation", "paths", "reason"].includes(key)) || !["inspect", "remove", "prune"].includes(String(input.operation))) throw new Error("Worktree operations: inspect, remove or prune; no force or branch deletion");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 || controls.test(input.reason)) throw new Error("Worktree reason must be short plain text");
  if (input.operation !== "inspect" && !Array.isArray(input.paths)) throw new Error("Worktree removal/pruning requires explicit absolute paths from inspection");
  if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 20 || new Set(input.paths).size !== input.paths.length || input.paths.some(path => typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || controls.test(path)))) throw new Error("Worktree paths must be 1–20 distinct canonical absolute paths");
  return JSON.parse(JSON.stringify(input)) as WorktreeRequest;
}

function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error("Worktree directories must be ordinary canonical directories");
  return [stat.dev, stat.ino];
}

function textFile(path: string, limit = 8192) {
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("Worktree metadata parent is redirected");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Worktree metadata file is linked, special or oversized");
    const value = readFileSync(fd, "utf8");
    if (fstatSync(fd).ctimeMs !== stat.ctimeMs) throw new Error("Worktree metadata changed while reading");
    return value.trim();
  } finally { closeSync(fd); }
}

function treeState(root: string, metadata = false, omit = new Set<string>()) {
  if (absent(root)) return { stamp: "absent", files: 0 };
  const digest = createHash("sha256"); let files = 0;
  const walk = (path: string) => {
    const rel = relative(root, path);
    if (omit.has(rel)) return;
    if (!metadata && rel !== ".git" && rel.split("/").includes(".git")) throw new Error("Worktree contains a nested repository; review that repository separately before cleanup");
    if (++files > 250000) throw new Error("Worktree inventory exceeds 250000 entries; narrow the cleanup");
    const stat = lstatSync(path);
    // APFS counts all directory children in nlink. The sorted inventory below
    // tracks them while allowing our own temporary lock files to be omitted.
    digest.update(JSON.stringify([rel, stat.dev, stat.ino, stat.mode, stat.isDirectory() ? null : [stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]]));
    if (stat.isDirectory()) {
      if (realpathSync(path) !== path) throw new Error("Worktree directory changed during inspection");
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (stat.isSymbolicLink() && !metadata) digest.update(readlinkSync(path));
    else if (!stat.isFile() || (metadata && (stat.nlink !== 1 || stat.size > 64 * 1024 * 1024))) throw new Error("Worktree contains unsupported special or linked metadata; preserve it and inspect the entry");
    else if (metadata) digest.update(readFileSync(path));
  };
  walk(root); return { stamp: digest.digest("hex"), files };
}

function entryState(entry: Pick<WorktreeEntry, "path" | "metadata" | "present">, omit = new Set<string>()) {
  const metadata = treeState(entry.metadata, true, omit), worktree = treeState(entry.path);
  return { stamp: hash(metadata.stamp + worktree.stamp), files: worktree.files };
}

export function worktreeIdentity(root: string, commonDir: string) {
  if (commonDir !== join(root, ".git")) throw new Error("Worktree cleanup requires the ordinary main repository");
  return hash(JSON.stringify([root, directory(root), directory(commonDir)]));
}

function validateEntry(snapshot: WorktreeSnapshot, entry: WorktreeEntry, omit = new Set<string>()) {
  const { root, commonDir } = snapshot;
  if (worktreeIdentity(root, commonDir) !== snapshot.identity || dirname(entry.metadata) !== join(commonDir, "worktrees")) throw new Error("Worktree repository identity changed");
  directory(entry.metadata);
  if (!isAbsolute(entry.path) || resolve(entry.path) !== entry.path || controls.test(entry.path) || inside(entry.path, root) || inside(commonDir, entry.path)) throw new Error("Worktree path overlaps the main repository or its metadata");
  if (resolve(entry.metadata, textFile(join(entry.metadata, "commondir"))) !== commonDir || textFile(join(entry.metadata, "gitdir")) !== join(entry.path, ".git")) throw new Error("Worktree metadata belongs to another repository");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.head)) throw new Error("Worktree recovery HEAD is invalid");
  const head = textFile(join(entry.metadata, "HEAD"));
  if (entry.branch !== null) {
    if (!entry.branch.startsWith("refs/heads/") || controls.test(entry.branch) || entry.branch.includes("\\") || entry.branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) || head !== "ref: " + entry.branch) throw new Error("Worktree branch changed or is invalid");
    const ref = join(commonDir, entry.branch), packed = join(commonDir, "packed-refs");
    const oid = !absent(ref) ? textFile(ref) : !absent(packed) ? textFile(packed, 64 * 1024 * 1024).split("\n").find(line => line.endsWith(" " + entry.branch))?.split(" ")[0] : undefined;
    if (oid !== entry.head) throw new Error("Worktree branch advanced during review; inspect again");
  } else if (head !== entry.head) throw new Error("Worktree detached HEAD changed during review");
  if (entry.present !== !absent(entry.path)) throw new Error("Worktree presence changed during review; inspect again");
  if (entry.present) {
    directory(entry.path);
    const marker = textFile(join(entry.path, ".git"));
    if (!marker.startsWith("gitdir: ") || resolve(entry.path, marker.slice(8)) !== entry.metadata) throw new Error("Worktree backlink is redirected");
  }
  if (entryState(entry, omit).stamp !== entry.stamp) throw new Error("Worktree files or metadata changed during review; inspect again");
}

/** Called by the fixed, offline Codex worker only. */
export async function inspectWorktrees(cwd: string, request: WorktreeRequest, signal?: AbortSignal): Promise<WorktreeSnapshot> {
  const env: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of Object.keys(process.env)) if (/^GIT_/.test(name) && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(name)) env[name] = undefined;
  env.GIT_OPTIONAL_LOCKS = "0"; env.GIT_TERMINAL_PROMPT = "0";
  const git = (path: string, args: string[]) => runProcess("/usr/bin/git", ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: path, env, signal, timeoutMs: 60000, maxBytes: 4 * 1024 * 1024 });
  const commonDir = realpathSync(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])), root = dirname(commonDir);
  const snapshot: WorktreeSnapshot = { root, commonDir, identity: worktreeIdentity(root, commonDir), entries: [] };
  const registry = join(commonDir, "worktrees");
  if (!absent(registry)) {
    directory(registry);
    const names = readdirSync(registry).sort();
    if (names.length > 1000) throw new Error("Worktree registry exceeds 1000 entries");
    for (const name of names) {
      signal?.throwIfAborted();
      const metadata = join(registry, name); directory(metadata);
      const marker = textFile(join(metadata, "gitdir")), path = dirname(marker);
      if (marker !== join(path, ".git") || !isAbsolute(path) || resolve(path) !== path || controls.test(path)) throw new Error("Worktree registry has an invalid path");
      if (request.paths && !request.paths.includes(path)) continue;
      const headText = textFile(join(metadata, "HEAD")), branch = headText.startsWith("ref: refs/heads/") ? headText.slice(5) : null;
      if (branch) await git(root, ["check-ref-format", branch]);
      else if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headText)) throw new Error("Worktree has an invalid HEAD");
      const head = await git(root, ["rev-parse", "--verify", "--end-of-options", `${branch ?? headText}^{commit}`]);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Worktree HEAD is not a commit");
      const present = !absent(path), locked = !absent(join(metadata, "locked"));
      const entry: WorktreeEntry = { path, metadata, head, branch, present, locked, dirty: false, knownRemote: false, ...entryState({ path, metadata, present }) };
      validateEntry(snapshot, entry);
      if (present) {
        // Like git_inspect, disable configured filters before status: clean and
        // process drivers can execute code even during a read-only inventory.
        const keys = (await git(path, ["config", "--null", "--name-only", "--list"])).split("\0");
        const drivers = new Set(keys.flatMap(key => { const match = /^filter\.(.+)\.[^.]+$/s.exec(key); return match ? [match[1]] : []; }));
        const overrides = [...drivers].flatMap(driver => [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]].flatMap(([key, value]) => ["-c", `filter.${driver}.${key}=${value}`]));
        entry.dirty = !!await git(path, [...overrides, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=all"]);
      }
      entry.knownRemote = !!await git(root, ["for-each-ref", `--contains=${head}`, "--format=%(refname)", "refs/remotes/"]);
      validateEntry(snapshot, entry);
      snapshot.entries.push(entry);
    }
  }
  if (request.paths && request.paths.some(path => !snapshot.entries.some(entry => entry.path === path))) throw new Error("Worktree path is not registered in this repository; inspect before choosing targets");
  return snapshot;
}

export function validateWorktreeRemoval(snapshot: WorktreeSnapshot, request: WorktreeRequest, cwd: string) {
  if (request.operation === "inspect" || !request.paths?.length || snapshot.entries.length !== request.paths.length || new Set(snapshot.entries.map(entry => entry.path)).size !== request.paths.length) throw new Error("Worktree cleanup requires the exact selected inventory");
  for (const entry of snapshot.entries) {
    if (!request.paths.includes(entry.path) || inside(entry.path, realpathSync(cwd)) || snapshot.entries.some(other => other !== entry && inside(entry.path, other.path))) throw new Error("Worktree cleanup overlaps the active workspace or another selected worktree");
    validateEntry(snapshot, entry);
    if (entry.locked) throw new Error("Worktree is locked; identify its owner and request an explicit unlock separately");
    if (entry.present !== (request.operation === "remove")) throw new Error("Worktree remove requires an existing directory; prune requires an explicitly selected missing directory");
    for (const marker of ["HEAD.lock", "index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      if (!absent(join(entry.metadata, marker))) throw new Error(`Worktree has an active operation (${marker}); wait for its owner before cleanup`);
    }
  }
}

/** Exact host filesystem publication, with recovery retained; no subprocesses. */
export function archiveWorktrees(snapshot: WorktreeSnapshot, request: WorktreeRequest, cwd: string, agentDir: string) {
  validateWorktreeRemoval(snapshot, request, cwd);
  directory(agentDir);
  if (inside(snapshot.root, agentDir) || snapshot.entries.some(entry => inside(entry.path, agentDir))) throw new Error("Worktree archive must be outside removed and active repositories");
  const archiveBase = join(agentDir, "worktree-archives");
  if (absent(archiveBase)) mkdirSync(archiveBase, { mode: 0o700 });
  directory(archiveBase);
  const privateStat = lstatSync(archiveBase);
  if ((privateStat.mode & 0o077) || (process.getuid && privateStat.uid !== process.getuid())) throw new Error("Worktree archive storage must be private and user-owned");
  const id = randomUUID(), archive = join(archiveBase, id), refs = join(snapshot.commonDir, "refs/pi/worktrees", id);
  for (let path = dirname(refs); inside(snapshot.commonDir, path); path = dirname(path)) if (!absent(path)) directory(path);
  for (const entry of snapshot.entries) {
    if (lstatSync(entry.metadata).dev !== privateStat.dev || (entry.present && lstatSync(entry.path).dev !== privateStat.dev)) throw new Error("Worktree archive is on another filesystem; prepare an explicit copy/verification plan before removal");
  }
  const locks: { path: string; fd: number; ino: number; dev: number }[] = [];
  const moved: { from: string; to: string }[] = [];
  const receipt = { version: 1, id, repository: snapshot.root, operation: request.operation, createdAt: new Date().toISOString(), entries: snapshot.entries.map((entry, index) => ({ ...entry, archive: join(archive, String(index)), recoveryRef: `refs/pi/worktrees/${id}/${index}` })), moved };
  let created = false;
  try {
    const lockPaths = [join(snapshot.commonDir, "pi-worktree-cleanup.lock"), ...snapshot.entries.flatMap(entry => [join(entry.metadata, "locked"), join(entry.metadata, "HEAD.lock"), join(entry.metadata, "index.lock"), ...(entry.branch ? [join(snapshot.commonDir, entry.branch + ".lock")] : [])])];
    for (const path of [...new Set(lockPaths)].sort()) {
      for (let parent = dirname(path); inside(snapshot.commonDir, parent); parent = dirname(parent)) if (!absent(parent)) directory(parent);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), stat = fstatSync(fd);
      locks.push({ path, fd, ino: stat.ino, dev: stat.dev });
    }
    for (const entry of snapshot.entries) validateEntry(snapshot, entry, new Set(["locked", "HEAD.lock", "index.lock"]));
    mkdirSync(archive, { mode: 0o700 }); created = true;
    mkdirSync(refs, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (let index = 0; index < snapshot.entries.length; index++) {
      const entry = snapshot.entries[index], destination = receipt.entries[index].archive;
      validateEntry(snapshot, entry, new Set(["locked", "HEAD.lock", "index.lock"]));
      writeFileSync(join(refs, String(index)), entry.head + "\n", { flag: "wx", mode: 0o600 });
      mkdirSync(destination, { mode: 0o700 });
      for (const [from, to] of [...(entry.present ? [[entry.path, join(destination, "worktree")]] : []), [entry.metadata, join(destination, "metadata")]]) {
        renameSync(from, to); moved.push({ from, to });
        for (const lock of locks) if (inside(from, lock.path)) lock.path = join(to, relative(from, lock.path));
        writeFileSync(join(archive, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      }
    }
    return { operation: request.operation, archive, receipt: join(archive, "receipt.json"), removed: receipt.entries.map(({ path, head, branch, recoveryRef }) => ({ path, head, branch, recoveryRef })), notice: "Worktrees deregistered. All local branches and remote state preserved. Files, including dirty, untracked and ignored files, and metadata retained in the private archive. Recovery refs retain every HEAD. No automatic purge or restore." };
  } catch (error) {
    throw new Error(`Worktree cleanup stopped: ${(error as Error).message}. ${created ? `Recovery archive: ${archive}; moved ${moved.length} path(s). Inspect receipt and current state before a new request.` : "No worktree moved."}`);
  } finally {
    for (const lock of locks) {
      closeSync(lock.fd);
      if (!absent(lock.path)) { const stat = lstatSync(lock.path); if (stat.dev === lock.dev && stat.ino === lock.ino && stat.isFile()) rmSync(lock.path); }
    }
  }
}
