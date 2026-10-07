// Checkpoints run against disposable metadata and files. Only validated metadata
// is published by the parent; Git/Jujutsu never execute on the host as a fallback.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { inflateSync } from "node:zlib";
import { runProcess } from "./process.ts";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
const controls = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u;
const absent = (path: string) => { try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
type Entry = { data: Buffer; mode: number; hash: string };
type Tree = Map<string, Entry>;
export interface CheckpointInspection { root: string; identity: string; initialized: boolean; files: string[] }
export interface CheckpointResult { root: string; operationId: string; commitId: string; initialized: boolean; tree: string }

export function checkpointReason(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "reason")) throw new Error("Expected only a checkpoint reason");
  const reason = (input as { reason?: unknown }).reason;
  if (typeof reason !== "string" || !reason.trim() || reason.length > 300 || controls.test(reason)) throw new Error("Expected a short checkpoint reason without control characters");
  return reason;
}

export function checkpointRoot(cwd: string): string {
  const start = realpathSync(cwd);
  for (let root = start; ; root = dirname(root)) {
    for (const marker of [".git", ".jj"]) {
      const path = join(root, marker);
      if (absent(path)) continue;
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("Checkpoint requires ordinary colocated metadata; links, worktrees and submodules are refused");
      // Like Git discovery, an empty ancestor directory is not a repository
      // (sandbox profiles can create these placeholders in temporary roots).
      if (marker === ".git" && root !== start && readdirSync(path).length === 0) continue;
      if (marker === ".jj" && absent(join(root, ".git"))) throw new Error("Checkpoint requires a colocated Git repository");
      return root;
    }
    if (!absent(join(root, "HEAD")) && !absent(join(root, "objects"))) throw new Error("Checkpoint refuses bare repositories");
    if (root === dirname(root)) return start;
  }
}

function regular(root: string, path: string): Entry {
  if (!inside(root, path) || realpathSync(dirname(path)) !== dirname(path)) throw new Error("Checkpoint path redirects outside its root");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error("Checkpoint refuses linked, special or oversized files");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.nlink !== 1) throw new Error("Checkpoint file changed before reading");
    const buffer = Buffer.alloc(before.size + 1); let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    const data = buffer.subarray(0, size), after = fstatSync(fd);
    if (before.ctimeMs !== after.ctimeMs || before.size !== data.length || after.nlink !== 1) throw new Error("Checkpoint file changed while reading");
    return { data, mode: stat.mode & 0o777, hash: hash(data) };
  } finally { closeSync(fd); }
}

function readTree(root: string, omit = new Set<string>()): Tree {
  const tree: Tree = new Map(); let bytes = 0, count = 0;
  if (absent(root)) return tree;
  const walk = (directory: string) => {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Checkpoint metadata contains a linked directory");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(root, path);
      if (omit.has(rel)) continue;
      if (++count > 20000 || controls.test(rel)) throw new Error("Checkpoint metadata exceeds its entry limit or contains unsafe names");
      if (lstatSync(path).isDirectory()) { walk(path); continue; }
      const entry = regular(root, path); bytes += entry.data.length;
      if (bytes > 128 * 1024 * 1024) throw new Error("Checkpoint metadata exceeds 128 MiB");
      if (rel.endsWith(".lock")) throw new Error("Checkpoint found an existing metadata lock; wait for its owner");
      tree.set(rel, entry);
    }
  };
  walk(root); return tree;
}
const same = (a: Tree, b: Tree) => a.size === b.size && [...a].every(([path, value]) => b.get(path)?.hash === value.hash && b.get(path)?.mode === value.mode);

function workFiles(root: string, paths: string[]): Tree {
  if (!Array.isArray(paths) || paths.length > 20000 || new Set(paths).size !== paths.length) throw new Error("Invalid checkpoint file list");
  const tree: Tree = new Map(); let bytes = 0;
  for (const path of paths) {
    if (typeof path !== "string" || !path || isAbsolute(path) || controls.test(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || [".git", ".jj"].includes(part))) throw new Error("Checkpoint refuses nested repositories or unsafe file paths");
    const target = join(root, path);
    for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
      if (!inside(root, parent)) throw new Error("Checkpoint path escapes its root");
      if (!absent(join(parent, ".git")) || !absent(join(parent, ".jj"))) throw new Error("Checkpoint refuses nested repositories");
    }
    if (absent(target)) continue; // Tracked deletion: absence is part of the snapshot.
    const entry = regular(root, target); bytes += entry.data.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("Checkpoint working files exceed 128 MiB");
    tree.set(path, entry);
  }
  return tree;
}

function writeEntry(root: string, path: string, entry: Entry, replace = false) {
  const target = join(root, path);
  if (!inside(root, target)) throw new Error("Checkpoint publication escapes its root");
  for (let parent = dirname(target); ; parent = dirname(parent)) {
    if (!absent(parent) && (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)) throw new Error("Checkpoint publication parent changed");
    if (parent === root) break;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = replace ? target + ".pi-" + randomUUID() : target;
  try {
    writeFileSync(temporary, entry.data, { flag: "wx", mode: entry.mode }); chmodSync(temporary, entry.mode);
    if (replace) renameSync(temporary, target);
  } finally { if (replace) rmSync(temporary, { force: true }); }
}

/** The parent binds consent and publication to host metadata, not sandbox mount identities. */
export function checkpointIdentity(root: string) {
  return hash(JSON.stringify([root, ...[root, join(root, ".git"), join(root, ".jj")].map(path => {
    if (absent(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error("Checkpoint repository identity changed");
    return [stat.dev, stat.ino];
  })]));
}

// Remove path/command redirections, but preserve user identity, ignore rules and
// signing policy. Configuration-dependent helpers still execute inside Codex.
function commandEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(process.env)) if (/^GIT_/.test(name) && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(name)) env[name] = undefined;
  for (const name of ["JJ_REPO", "JJ_WORKSPACE", "JJ_OP_LOG", "JJ_EDITOR", "VISUAL", "EDITOR"]) env[name] = undefined;
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}
const git = async (cwd: string, args: string[], signal?: AbortSignal) => {
  const chunks: Buffer[] = [];
  await runProcess("/usr/bin/git", ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, signal, env: commandEnv(), timeoutMs: 60000, maxBytes: 4 * 1024 * 1024, onStdout: chunk => chunks.push(chunk) });
  const output = Buffer.concat(chunks).toString("utf8");
  return args.includes("-z") ? output : output.trim();
};
const jj = async (binary: string, cwd: string, args: string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = {}) => {
  const chunks: Buffer[] = [];
  try {
    await runProcess(binary, ["--no-pager", "--color=never", ...args], { cwd, signal, env: { ...commandEnv(), ...env }, timeoutMs: 120000, maxBytes: 4 * 1024 * 1024, onStdout: chunk => chunks.push(chunk) });
  } catch (error) {
    // Classify known failures without exposing helper stderr or config values.
    if (error instanceof Error && /Failed to determine the secure config/.test(error.message)) throw new Error("Checkpoint cannot access jj secure repository configuration inside the sandbox; no host retry.");
    throw error;
  }
  const output = Buffer.concat(chunks).toString("utf8");
  return args.includes("list") ? output : output.trim();
};

// Jj may write secure per-repository configuration even during initialization or
// read-only inspection of copied metadata. Keep those writes disposable, while
// retaining the normal system, HOME, JJ_CONFIG and XDG configuration layers.
async function withJjConfig<T>(cwd: string, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const original = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(original)) throw new Error("Checkpoint requires an absolute XDG_CONFIG_HOME");
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-jj-config-")));
  try {
    mkdirSync(join(temporary, "jj"), { mode: 0o700 });
    for (const directory of ["", "jj"]) {
      const source = join(original, directory);
      if (absent(source)) continue;
      const names = readdirSync(source);
      if (names.length > 20000) throw new Error("Checkpoint configuration exceeds its entry limit");
      for (const name of names) {
        if (directory ? ["repos", "workspaces"].includes(name) : name === "jj") continue;
        symlinkSync(join(source, name), join(temporary, directory, name));
      }
    }
    for (const [idPath, kind] of [["repo/config-id", "repos"], ["workspace-config-id", "workspaces"]]) {
      const path = join(cwd, ".jj", idPath);
      if (absent(path)) continue;
      const id = regular(join(cwd, ".jj"), path).data.toString();
      if (!/^[a-f0-9]{20}$/.test(id)) throw new Error("Checkpoint found an invalid jj configuration ID");
      const source = join(original, "jj", kind, id), target = join(temporary, "jj", kind, id);
      for (const name of ["metadata.binpb", "config.toml"]) {
        if (absent(join(source, name))) continue;
        writeEntry(target, name, { ...regular(source, join(source, name)), mode: 0o600 });
      }
    }
    return await run({ XDG_CONFIG_HOME: temporary });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Inspection and commands below are called only by the confined fixed worker. */
export async function inspectCheckpoint(cwd: string, binary: string, signal?: AbortSignal): Promise<CheckpointInspection> {
  const root = checkpointRoot(cwd), initialized = !absent(join(root, ".jj"));
  if (!absent(join(root, ".gitmodules"))) throw new Error("Checkpoint refuses repositories with submodules");
  if (initialized && regular(join(root, ".jj"), join(root, ".jj/repo/store/git_target")).data.toString() !== "../../../.git") throw new Error("Checkpoint requires a local colocated Git store");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "worktrees", "objects/info/alternates", "info/sparse-checkout"]) {
    if (!absent(join(root, ".git", name))) throw new Error(`Checkpoint refuses repository state .git/${name}; finish the operation or use an ordinary unshared, non-sparse repository`);
  }
  let scratch: string | undefined;
  try {
    let prefix: string[] = [];
    // An empty metadata directory is not an initialized repository.
    if (absent(join(root, ".git")) || readdirSync(join(root, ".git")).length === 0) {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-jj-inspect-")));
      await git(scratch, ["init", "--template=", "--initial-branch=main"], signal);
      prefix = ["--git-dir=" + join(scratch, ".git"), "--work-tree=" + root];
    } else {
      if (await git(root, ["rev-parse", "--show-toplevel"], signal) !== root || await git(root, ["rev-parse", "--is-bare-repository"], signal) !== "false") throw new Error("Checkpoint found redirected Git metadata");
    }
    const paths = (await git(root, [...prefix, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal)).split("\0").filter(Boolean);
    if (initialized) paths.push(...(await withJjConfig(root, env => jj(binary, root, ["--ignore-working-copy", "file", "list", "-T", 'path ++ "\\0"'], signal, env))).split("\0").filter(Boolean));
    return { root, identity: checkpointIdentity(root), initialized, files: [...new Set(paths.filter(path => !path.startsWith(".jj/") && !path.startsWith(".git/")))].sort() };
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

export function createCheckpointTransaction(info: CheckpointInspection) {
  if (checkpointRoot(info.root) !== info.root || checkpointIdentity(info.root) !== info.identity) throw new Error("Checkpoint repository changed before preparation");
  const gitBefore = readTree(join(info.root, ".git")), jjBefore = readTree(join(info.root, ".jj")), files = workFiles(info.root, info.files);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-jj-checkpoint-"))), stage = join(temporary, "repo");
  if (inside(info.root, temporary)) { rmSync(temporary, { recursive: true }); throw new Error("Checkpoint temporary storage must be outside the project"); }
  try {
    mkdirSync(stage); mkdirSync(join(stage, ".git"));
    if (gitBefore.size) {
      for (const name of ["objects/info", "objects/pack", "refs/heads", "refs/tags"]) mkdirSync(join(stage, ".git", name), { recursive: true });
      for (const [path, entry] of gitBefore) writeEntry(join(stage, ".git"), path, entry);
    }
    if (info.initialized) { mkdirSync(join(stage, ".jj")); for (const [path, entry] of jjBefore) writeEntry(join(stage, ".jj"), path, entry); }
    for (const [path, entry] of files) writeEntry(stage, path, entry);
    // Missing protected paths can appear as empty files in the Linux sandbox.
    // Materialize empty directories in the disposable copy before mounting it;
    // they add no Git tree entries and do not replace real selected resources.
    for (const name of [".pi", ".agents", ".codex"]) if (absent(join(stage, name))) mkdirSync(join(stage, name), { mode: 0o700 });
    return { temporary, stage, info, gitBefore, jjBefore, files };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
export type CheckpointTransaction = ReturnType<typeof createCheckpointTransaction>;
export function closeCheckpointTransaction(tx: CheckpointTransaction) { rmSync(tx.temporary, { recursive: true, force: true }); }

export async function runCheckpoint(stage: string, binary: string, signal?: AbortSignal): Promise<CheckpointResult> {
  if (absent(join(stage, ".git/HEAD"))) await git(stage, ["init", "--template=", "--initial-branch=main"], signal);
  const initialized = absent(join(stage, ".jj"));
  const { operationId, commitId } = await withJjConfig(stage, async env => {
    if (initialized) await jj(binary, stage, ["git", "init", "--colocate"], signal, env);
    await jj(binary, stage, ["util", "snapshot"], signal, env);
    const operationId = await jj(binary, stage, ["--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "self.id()"], signal, env);
    const commitId = await jj(binary, stage, ["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"], signal, env);
    return { operationId, commitId };
  });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitId)) throw new Error("Checkpoint returned an invalid commit ID");
  const tree = await git(stage, ["ls-tree", "-r", "-z", commitId], signal);
  return { root: stage, operationId, commitId, initialized, tree };
}

function validateJj(tree: Tree, before: Tree) {
  const hex = "[a-f0-9]{128}";
  const allowed = new RegExp(`^(?:\\.gitignore|working_copy/(?:checkout|tree_state|type)|repo/(?:workspace_store/index|(?:index|op_heads|op_store|store|submodule_store)/type|store/git_target|index/(?:op_links|segments)/${hex}|op_heads/heads/${hex}|op_store/(?:operations|views)/${hex}|store/extra/(?:heads/)?${hex}))$`);
  for (const [path, entry] of tree) {
    if (before.get(path)?.hash === entry.hash && before.get(path)?.mode === entry.mode) continue;
    // Copied repositories receive private config IDs. Never publish pointers to
    // temporary configuration or replace the original repository's settings.
    if (["repo/config-id", "workspace-config-id"].includes(path)) {
      if (!/^[a-f0-9]{20}$/.test(entry.data.toString()) || (entry.mode & 0o111)) throw new Error("Checkpoint produced an invalid jj configuration ID");
      const original = before.get(path);
      if (original) tree.set(path, original); else tree.delete(path);
      continue;
    }
    // Init may write a convenience trunk alias. It is unnecessary for recovery;
    // publishing executable/configuration input is outside this capability.
    if (path === "repo/config.toml" && !before.has(path)) { tree.delete(path); continue; }
    if (!allowed.test(path) || (entry.mode & 0o111)) throw new Error("Checkpoint produced unapproved jj metadata");
    if (before.has(path) && !/^(?:working_copy\/(?:checkout|tree_state)|repo\/workspace_store\/index|repo\/index\/op_links\/[a-f0-9]{128})$/.test(path)) throw new Error("Checkpoint rewrote immutable jj metadata");
  }
  for (const path of before.keys()) if (!tree.has(path) && !new RegExp(`^repo/(?:op_heads|store/extra)/heads/${hex}$`).test(path)) throw new Error("Checkpoint removed unapproved jj metadata");
  if (tree.get("repo/store/git_target")?.data.toString() !== "../../../.git" || tree.get(".gitignore")?.data.toString() !== "/*\n") throw new Error("Checkpoint changed its colocated store");
}

export function publishCheckpoint(tx: CheckpointTransaction, result: CheckpointResult) {
  if (result.root !== tx.stage || result.initialized !== !tx.info.initialized || !/^[a-f0-9]{128}$/.test(result.operationId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commitId)) throw new Error("Invalid checkpoint result");
  if (typeof result.tree !== "string" || Buffer.byteLength(result.tree) > 4 * 1024 * 1024) throw new Error("Invalid checkpoint tree");
  const captured = new Map<string, { mode: string; oid: string }>();
  for (const line of result.tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(line);
    if (!match || captured.has(match[3])) throw new Error("Checkpoint tree contains unsupported entries");
    captured.set(match[3], { mode: match[1], oid: match[2] });
  }
  const omitted = [...tx.files.keys()].filter(path => !captured.has(path));
  const unexpected = [...captured.keys()].filter(path => !tx.files.has(path));
  const different = [...tx.files].filter(([path, entry]) => {
    const oid = createHash(result.commitId.length === 40 ? "sha1" : "sha256").update(`blob ${entry.data.length}\0`).update(entry.data).digest("hex");
    return captured.has(path) && (captured.get(path)?.oid !== oid || captured.get(path)?.mode !== (entry.mode & 0o111 ? "100755" : "100644"));
  }).map(([path]) => path);
  if (omitted.length || unexpected.length || different.length) throw new Error("Checkpoint did not capture every selected file exactly; inspect jj ignore, auto-track, size or conversion settings: " + JSON.stringify({ omitted: omitted.slice(0, 20), unexpected: unexpected.slice(0, 20), different: different.slice(0, 20) }));
  const afterGit = readTree(join(tx.stage, ".git")), afterJj = readTree(join(tx.stage, ".jj"));
  validateJj(afterJj, tx.jjBefore);
  if (!afterJj.has("repo/op_heads/heads/" + result.operationId) || !afterJj.has("repo/op_store/operations/" + result.operationId)) throw new Error("Checkpoint operation is not present in its store");
  if (!tx.gitBefore.size && (!afterGit.has("HEAD") || !afterGit.has("config"))) throw new Error("Checkpoint is missing initial Git metadata");
  const additions: Tree = new Map();
  for (const [path, entry] of afterGit) {
    const before = tx.gitBefore.get(path);
    if (before?.hash === entry.hash && before.mode === entry.mode) continue;
    if (path === "index") continue; // jj does not preserve staging; the real index does.
    if (!tx.gitBefore.size && ["HEAD", "config", "description"].includes(path)) {
      if (path === "HEAD" && entry.data.toString() !== "ref: refs/heads/main\n") throw new Error("Unexpected initial Git HEAD");
      // Git records filesystem case handling and Unicode normalization on macOS.
      // Admit only these optional booleans, never arbitrary configuration or helpers.
      if (path === "config" && !/^\[core\]\n\trepositoryformatversion = 0\n\tfilemode = (?:true|false)\n\tbare = false\n\tlogallrefupdates = true\n(?:\tignorecase = (?:true|false)\n)?(?:\tprecomposeunicode = (?:true|false)\n)?$/.test(entry.data.toString())) throw new Error("Unexpected initial Git configuration");
      additions.set(path, entry); continue;
    }
    const object = /^objects\/([a-f0-9]{2})\/([a-f0-9]{38}|[a-f0-9]{62})$/.exec(path);
    const keep = /^refs\/jj\/keep\/([a-f0-9]{40}|[a-f0-9]{64})$/.exec(path);
    if (before || (!object && !keep)) throw new Error("Checkpoint modified unapproved Git metadata");
    if (object) {
      const oid = object[1] + object[2];
      if (createHash(oid.length === 40 ? "sha1" : "sha256").update(inflateSync(entry.data, { maxOutputLength: 64 * 1024 * 1024 })).digest("hex") !== oid) throw new Error("Checkpoint object hash mismatch");
    } else if (entry.data.toString() !== keep![1] + "\n") throw new Error("Checkpoint keep reference mismatch");
    additions.set(path, entry);
  }
  for (const path of tx.gitBefore.keys()) if (!afterGit.has(path)) throw new Error("Checkpoint removed Git metadata");
  // Keep recovery content reachable independently of jj's operation retention.
  // This private ref does not create/move a branch and never leaves the machine.
  const gitRef = "refs/pi/checkpoints/" + result.operationId, pinned = Buffer.from(result.commitId + "\n");
  const existingPin = tx.gitBefore.get(gitRef);
  if (existingPin && !existingPin.data.equals(pinned)) throw new Error("Checkpoint retention reference conflicts with existing metadata");
  if (!existingPin) additions.set(gitRef, { data: pinned, mode: 0o600, hash: hash(pinned) });
  if (!same(tx.files, workFiles(tx.stage, [...tx.files.keys()]))) throw new Error("Checkpoint worker changed working files");
  const root = tx.info.root;
  const verifySource = (omitGit = new Set<string>(), omitJj = new Set<string>()) => {
    if (checkpointIdentity(root) !== tx.info.identity || !same(tx.gitBefore, readTree(join(root, ".git"), omitGit)) || !same(tx.jjBefore, readTree(join(root, ".jj"), omitJj)) || !same(tx.files, workFiles(root, tx.info.files))) throw new Error("Checkpoint source changed; nothing published");
  };
  verifySource();
  const locks: { path: string; fd: number; ino: number; dev: number }[] = [];
  let published = false;
  try {
    if (tx.gitBefore.size) {
      for (const name of ["HEAD.lock", "index.lock", "pi-checkpoint.lock"]) {
        const path = join(root, ".git", name), fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), stat = fstatSync(fd);
        locks.push({ path, fd, ino: stat.ino, dev: stat.dev });
      }
    }
    verifySource(new Set(locks.map(lock => relative(join(root, ".git"), lock.path))));
    if (!tx.gitBefore.size && absent(join(root, ".git"))) { mkdirSync(join(root, ".git"), { mode: 0o700 }); published = true; }
    for (const [path, entry] of [...additions].sort(([a], [b]) => a.localeCompare(b))) { writeEntry(join(root, ".git"), path, entry); published = true; }
    // Objects precede operation data; the operation head and checkout move last.
    if (!tx.info.initialized) { mkdirSync(join(root, ".jj"), { mode: 0o700 }); published = true; }
    const priority = (path: string) => path.startsWith("working_copy/") ? 2 : path.startsWith("repo/op_heads/heads/") ? 1 : 0;
    for (const [path, entry] of [...afterJj].sort(([a], [b]) => priority(a) - priority(b))) {
      const previous = tx.jjBefore.get(path);
      if (previous?.hash === entry.hash && previous.mode === entry.mode) continue;
      writeEntry(join(root, ".jj"), path, entry, !!previous); published = true;
    }
    for (const path of tx.jjBefore.keys()) if (!afterJj.has(path)) rmSync(join(root, ".jj", path));
    return { root, operationId: result.operationId, commitId: result.commitId, gitRef, initialized: result.initialized, files: captured.size, notice: "Local working-file checkpoint. Git index and branches preserved. Ignored/untracked exclusions and external services are not backed up. Restore requires a separate explicit request." };
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${published ? "partial checkpoint metadata may exist" : "no checkpoint published"}. Inspect state; no automatic retry.`);
  } finally {
    for (const lock of locks) {
      closeSync(lock.fd);
      if (!absent(lock.path)) { const stat = lstatSync(lock.path); if (stat.ino === lock.ino && stat.dev === lock.dev && stat.isFile()) rmSync(lock.path); }
    }
  }
}
