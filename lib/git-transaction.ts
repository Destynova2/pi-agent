// Linux bind mounts cannot atomically replace individually granted Git files.
// Git and its hooks run in Codex against disposable metadata; this parent broker
// publishes only validated Git data using native lockfiles, never a host Git command.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { GitRequest, GitSnapshot } from "../extensions/tool-policy/git-access-core.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent: string, path: string) => { const rel = relative(parent, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
type Entry = { bytes: Buffer; hash: string; mode: number };
type Tree = Map<string, Entry>;

function readTree(root: string, omit = new Set<string>()): Tree {
  const result: Tree = new Map();
  let bytes = 0;
  const walk = (directory: string) => {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Linked Git transaction directory refused");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(root, path);
      if (omit.has(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || realpathSync(path) !== path) throw new Error("Linked, special or oversized Git transaction file refused");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd), data = readFileSync(fd), after = fstatSync(fd);
        if (before.ino !== stat.ino || before.dev !== stat.dev || before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || data.length !== before.size) throw new Error("Git transaction file changed while reading");
        bytes += data.length;
        if (bytes > 128 * 1024 * 1024 || result.size >= 20000) throw new Error("Git transaction metadata exceeds its size limit");
        result.set(rel, { bytes: data, hash: digest(data), mode: stat.mode & 0o777 });
      } finally { closeSync(fd); }
    }
  };
  walk(root);
  return result;
}

function sameTree(a: Tree, b: Tree) {
  return a.size === b.size && [...a].every(([path, value]) => b.get(path)?.hash === value.hash && b.get(path)?.mode === value.mode);
}

function safeParents(root: string, path: string) {
  if (!inside(root, path)) throw new Error("Git transaction path escapes its metadata directory");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (existsSync(parent) && (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)) throw new Error("Linked Git transaction parent refused");
    if (parent === root) break;
  }
}

export function createGitTransaction(snapshot: GitSnapshot, request: GitRequest) {
  if (!inside(snapshot.commonDir, snapshot.gitDir) || realpathSync(snapshot.commonDir) !== snapshot.commonDir) throw new Error("Unsupported Git transaction layout");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-transaction-")));
  if (inside(snapshot.root, root)) { rmSync(root, { recursive: true }); throw new Error("Git transaction storage must be outside the project"); }
  const commonDir = join(root, "metadata"), gitDir = join(commonDir, relative(snapshot.commonDir, snapshot.gitDir));
  const sourceStat = lstatSync(snapshot.commonDir);
  try {
    const before = readTree(snapshot.commonDir, new Set(["objects"]));
    if ([...before.keys()].some(path => path.endsWith(".lock"))) throw new Error("A Git lock already exists; inspect the running operation");
    mkdirSync(commonDir);
    mkdirSync(join(commonDir, "refs"));
    for (const [path, entry] of before) {
      const target = join(commonDir, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.mode });
      chmodSync(target, entry.mode);
    }
    // Objects are immutable and read through the original pool. Only NEW objects
    // enter the disposable pool and are eligible for publication.
    mkdirSync(join(commonDir, "objects/info"), { recursive: true, mode: 0o700 });
    const alternates = snapshot.commonDir + "/objects\n";
    writeFileSync(join(commonDir, "objects/info/alternates"), alternates, { mode: 0o600 });
    const baseline = readTree(commonDir, new Set(["objects"]));
    if (!sameTree(before, baseline) || !sameTree(before, readTree(snapshot.commonDir, new Set(["objects"])))) throw new Error("Git state changed while preparing the transaction");
    const readOnlyRoots = [...new Set([join(commonDir, "config"), join(commonDir, "config.worktree"), join(commonDir, "hooks"), join(commonDir, "info"), join(gitDir, "config.worktree")])];
    return { root, commonDir, gitDir, snapshot, request, before, alternates, sourceStat, readOnlyRoots };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

export type GitTransaction = ReturnType<typeof createGitTransaction>;

export function publishGitTransaction(tx: GitTransaction) {
  const { snapshot, request } = tx;
  const after = readTree(tx.commonDir, new Set(["objects"]));
  const local = (name: string) => relative(snapshot.commonDir, join(snapshot.gitDir, name));
  const branch = request.operation === "branch" ? request.branch : snapshot.branch;
  const allowed = new Set(request.operation === "stage" ? [local("index")]
    : request.operation === "commit" ? [local("index"), local("COMMIT_EDITMSG"), local("logs/HEAD"), "refs/heads/" + branch, "logs/refs/heads/" + branch]
    : request.operation === "branch" ? [local("index"), local("HEAD"), local("logs/HEAD"), "refs/heads/" + branch, "logs/refs/heads/" + branch]
    : ["refs/remotes/" + request.remote + "/" + request.branch, "logs/refs/remotes/" + request.remote + "/" + request.branch]);
  const changed: string[] = [];
  for (const path of new Set([...tx.before.keys(), ...after.keys()])) {
    const before = tx.before.get(path), next = after.get(path);
    if (before?.hash === next?.hash && before?.mode === next?.mode) continue;
    if (!next || !allowed.has(path)) throw new Error("Git transaction modified unapproved metadata; nothing published");
    changed.push(path);
  }
  if (readFileSync(join(tx.commonDir, "objects/info/alternates"), "utf8") !== tx.alternates) throw new Error("Git transaction changed its object pool");
  const objects = readTree(join(tx.commonDir, "objects"), new Set(["info/alternates"]));
  for (const [path, entry] of objects) {
    if (!/^[a-f0-9]{2}\/(?:[a-f0-9]{38}|[a-f0-9]{62})$/.test(path)) throw new Error("Git transaction produced an unsupported object artifact");
    if (!["stage", "commit"].includes(request.operation)) throw new Error("This Git operation cannot publish objects");
    const oid = path.replace("/", "");
    if (createHash(oid.length === 40 ? "sha1" : "sha256").update(inflateSync(entry.bytes, { maxOutputLength: 64 * 1024 * 1024 })).digest("hex") !== oid) throw new Error("Git transaction object content does not match its ID");
  }
  const stat = lstatSync(snapshot.commonDir);
  if (stat.dev !== tx.sourceStat.dev || stat.ino !== tx.sourceStat.ino || realpathSync(snapshot.commonDir) !== snapshot.commonDir) throw new Error("Git metadata directory changed; nothing published");
  const locks = new Map<string, { fd: number; stat: ReturnType<typeof fstatSync> }>(), published: string[] = [];
  const lockNames = new Set(changed.map(path => path + ".lock"));
  if (request.operation !== "push") {
    for (const name of ["HEAD.lock", "index.lock"]) lockNames.add(relative(snapshot.commonDir, join(snapshot.gitDir, name)));
    if (snapshot.branch) lockNames.add("refs/heads/" + snapshot.branch + ".lock");
  }
  try {
    for (const name of [...lockNames].sort()) {
      const target = join(snapshot.commonDir, name);
      safeParents(snapshot.commonDir, target);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      locks.set(name, { fd, stat: fstatSync(fd) });
    }
    const current = readTree(snapshot.commonDir, new Set(["objects", ...locks.keys()]));
    if (!sameTree(tx.before, current)) throw new Error("Git state changed during the transaction; nothing published");
    // Validate all object destinations before any write. Existing objects must be
    // regular and byte-identical; never overwrite them or follow pool symlinks.
    for (const [path, entry] of objects) {
      const target = join(snapshot.commonDir, "objects", path);
      safeParents(snapshot.commonDir, target);
      if (existsSync(target)) {
        const current = lstatSync(target);
        if (!current.isFile() || current.nlink !== 1 || realpathSync(target) !== target || digest(readFileSync(target)) !== entry.hash) throw new Error("Conflicting Git object; nothing published");
      }
    }
    for (const [path, entry] of objects) {
      const target = join(snapshot.commonDir, "objects", path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      try { writeFileSync(target, entry.bytes, { flag: "wx", mode: 0o444 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(readFileSync(target)) !== entry.hash) throw error; }
    }
    for (const path of changed) {
      const entry = after.get(path)!, lock = locks.get(path + ".lock")!;
      writeFileSync(lock.fd, entry.bytes); fchmodSync(lock.fd, entry.mode); fsyncSync(lock.fd);
    }
    // Publish objects before refs, and refs before switching HEAD. As with native
    // Git, an I/O failure can leave partial effects; report them and never retry.
    changed.sort((a, b) => Number(a.endsWith("HEAD")) - Number(b.endsWith("HEAD")));
    for (const path of changed) {
      const name = path + ".lock", lock = locks.get(name)!, lockPath = join(snapshot.commonDir, name);
      const actual = lstatSync(lockPath);
      if (actual.dev !== lock.stat.dev || actual.ino !== lock.stat.ino || !actual.isFile() || actual.nlink !== 1) throw new Error("Git transaction lock changed");
      closeSync(lock.fd); lock.fd = -1;
      safeParents(snapshot.commonDir, lockPath);
      renameSync(lockPath, join(snapshot.commonDir, path));
      locks.delete(name); published.push(path);
    }
    return published;
  } catch (error) {
    throw new Error((error as Error).message + "; published metadata: " + (published.join(", ") || "none") + ". Inspect state before any new operation.");
  } finally {
    for (const [name, lock] of locks) {
      if (lock.fd !== -1) closeSync(lock.fd);
      const path = join(snapshot.commonDir, name);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (stat.dev === lock.stat.dev && stat.ino === lock.stat.ino && stat.isFile()) rmSync(path);
      }
    }
  }
}

export function closeGitTransaction(tx: GitTransaction) { rmSync(tx.root, { recursive: true, force: true }); }
