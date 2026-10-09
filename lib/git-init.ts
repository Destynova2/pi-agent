// New repositories are built in private scratch space. Only checked Git metadata
// is published; existing files, repositories and configuration are never replaced.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { commitHookOptions, gitEnvironment } from "./git-command.ts";
import { runProcess } from "./process.ts";

export interface GitInitRequest {
  repository: string;
  branch: string;
  remote: string;
  url: string;
  author_name: string;
  author_email: string;
  message: string;
  reason: string;
}
const controls = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const absent = (path: string) => { try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };

export function validateGitInit(value: unknown): GitInitRequest {
  const fields = ["repository", "branch", "remote", "url", "author_name", "author_email", "message", "reason"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Git initialization request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => typeof input[key] !== "string" || !(input[key] as string).trim() || (input[key] as string).length > 1024 || controls.test(input[key] as string))) throw new Error("Git initialization requires exact fields and bounded text without control characters");
  const request = { ...input } as unknown as GitInitRequest;
  if (!isAbsolute(request.repository) || resolve(request.repository) !== request.repository || request.repository === dirname(request.repository)) throw new Error("Expected a canonical repository directory, not a filesystem root");
  if (request.branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(request.branch) || request.branch.includes("..") || request.branch.endsWith(".") || request.branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new Error("Expected a literal initial branch name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.remote)) throw new Error("Expected a literal remote name");
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") || url.pathname === "/" || url.href !== request.url) throw new Error("Initial remote must be a canonical HTTPS URL without credentials, query or fragment");
  if (/[<>]/.test(request.author_name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(request.author_email)) throw new Error("Expected an explicit Git author name and email");
  return request;
}

export function inspectGitInitTarget(repository: string) {
  for (let path = repository; ; path = dirname(path)) {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("Repository destination must be an existing canonical directory without links");
    if (path === dirname(path)) break;
  }
  for (const name of [".git", ".jj"]) if (!absent(join(repository, name))) throw new Error("Destination already has repository metadata; nothing replaced");
  const stat = lstatSync(repository);
  return hash(JSON.stringify([repository, stat.dev, stat.ino, stat.birthtimeMs]));
}

export function createGitInitStage() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-init-")));
  const metadata = join(root, "metadata"), worktree = join(root, "worktree");
  mkdirSync(metadata); mkdirSync(worktree);
  // Give Codex's protected .pi entry a directory mount target, not a file stub.
  mkdirSync(join(worktree, ".pi"));
  return { root, metadata, worktree };
}
export type GitInitStage = ReturnType<typeof createGitInitStage>;
export function closeGitInitStage(stage: GitInitStage) { rmSync(stage.root, { recursive: true, force: true }); }

function metadataFiles(root: string) {
  const files = new Map<string, { bytes: Buffer; mode: number }>();
  let bytes = 0, entries = 0;
  const walk = (directory: string) => {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Linked Git initialization directory refused");
    for (const name of readdirSync(directory).sort()) {
      if (++entries > 2000) throw new Error("Initialization metadata exceeds its entry limit");
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || realpathSync(path) !== path) throw new Error("Linked, special or oversized initialization metadata refused");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd);
        if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw new Error("Initialization metadata changed while opening");
        const buffer = Buffer.alloc(before.size + 1);
        let size = 0, count: number;
        while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
        const after = fstatSync(fd), data = buffer.subarray(0, size);
        if (before.ctimeMs !== after.ctimeMs || size !== before.size || after.nlink !== 1) throw new Error("Initialization metadata changed while reading");
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024 || files.size >= 1000) throw new Error("Initialization metadata exceeds its limit");
        files.set(relative(root, path), { bytes: data, mode: stat.mode & 0o777 });
      } finally { closeSync(fd); }
    }
  };
  walk(root);
  return files;
}

function validateMetadata(metadata: string, request: GitInitRequest, head: string) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid initial commit ID");
  const files = metadataFiles(metadata), ref = `refs/heads/${request.branch}`;
  const fixed = new Set(["HEAD", "config", "description", "COMMIT_EDITMSG", "index", "info/exclude", "logs/HEAD", `logs/${ref}`, ref]);
  for (const [path, file] of files) {
    if (!fixed.has(path) && !/^hooks\/[A-Za-z0-9_.-]+$/.test(path) && !/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(path)) throw new Error("Unexpected initialization metadata");
    if (path.startsWith("objects/")) {
      const content = inflateSync(file.bytes, { maxOutputLength: 1024 * 1024 });
      if (createHash("sha1").update(content).digest("hex") !== path.slice(8).replace("/", "")) throw new Error("Invalid initialization object");
    }
  }
  if (files.get("HEAD")?.bytes.toString() !== `ref: ${ref}\n` || files.get(ref)?.bytes.toString() !== `${head}\n`) throw new Error("Initial branch differs from the approved request");
  const object = files.get(`objects/${head.slice(0, 2)}/${head.slice(2)}`);
  if (!object) throw new Error("Missing initial commit object");
  const commit = inflateSync(object.bytes, { maxOutputLength: 1024 * 1024 }).toString();
  if (!/^commit [0-9]+\0/.test(commit) || !commit.split("\0")[1]?.startsWith(`tree ${emptyTree}\n`) || /^parent /m.test(commit.split("\n\n")[0])) throw new Error("Initial commit must have an empty tree and no parent");
  return { files, fingerprint: hash(JSON.stringify([...files].map(([path, entry]) => [path, hash(entry.bytes), entry.mode]))) };
}

/** Fixed worker only: caller starts this inside the OS sandbox, never on the host. */
export async function initializeGit(stage: GitInitStage, request: GitInitRequest, signal?: AbortSignal) {
  const environment = { ...gitEnvironment(), GIT_DIR: stage.metadata, GIT_WORK_TREE: stage.worktree,
    GIT_AUTHOR_NAME: request.author_name, GIT_AUTHOR_EMAIL: request.author_email,
    GIT_COMMITTER_NAME: request.author_name, GIT_COMMITTER_EMAIL: request.author_email };
  const git = (args: string[], input?: string, env: NodeJS.ProcessEnv = {}) => runProcess("/usr/bin/git", ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: stage.worktree, env: { ...environment, ...env }, signal, input, timeoutMs: 60000, maxBytes: 1024 * 1024 });
  // Codex mounts empty protected placeholders beneath each writable root.
  // They are not repository contents and stay protected throughout the worker.
  const placeholders = new Set([".git", ".codex", ".agents", ".pi"]);
  for (const directory of [stage.metadata, stage.worktree]) for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!placeholders.has(name) || !lstatSync(path).isDirectory() || realpathSync(path) !== path || readdirSync(path).length) throw new Error("Git initialization needs fresh private scratch directories");
  }
  await git(["init", "--object-format=sha1", `--initial-branch=${request.branch}`]);
  // Git records the separate scratch worktree. The published .git must resolve
  // its real parent instead; never carry that temporary path into the new repo.
  if (await git(["config", "--local", "core.worktree"]) !== stage.worktree) throw new Error("Unexpected initialization worktree");
  await git(["config", "--local", "--unset", "core.worktree"]);
  await git(["config", "--local", "user.name", request.author_name]);
  await git(["config", "--local", "user.email", request.author_email]);
  await git(["remote", "add", "--", request.remote, request.url]);
  const hooks = resolve(stage.worktree, await git(["rev-parse", "--git-path", "hooks"]));
  const guarded = commitHookOptions(emptyTree, "", request.branch, hooks);
  await git([...guarded.args, "commit", "--allow-empty", "--file=-"], request.message, guarded.env);
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  // No redirects, include files, external object pools or executable config may
  // enter the new repository. Templates and global signing/hooks still run jailed.
  const expected = new Map([
    ["core.repositoryformatversion", "0"], ["core.bare", "false"],
    ["user.name", request.author_name], ["user.email", request.author_email],
    [`remote.${request.remote}.url`, request.url], [`remote.${request.remote}.fetch`, `+refs/heads/*:refs/remotes/${request.remote}/*`],
  ]);
  const booleans = new Set(["core.filemode", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode"]);
  const seen = new Set<string>();
  for (const entry of (await git(["config", "--local", "--no-includes", "--null", "--list"])).split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
    if (split < 0 || seen.has(key) || (expected.has(key) ? value !== expected.get(key) : !booleans.has(key) || !["true", "false"].includes(value))) throw new Error("Unexpected initial Git configuration");
    seen.add(key);
  }
  if ([...expected.keys()].some(key => !seen.has(key))) throw new Error("Missing initial Git configuration");
  const { fingerprint } = validateMetadata(stage.metadata, request, head);
  return { head, fingerprint };
}

export function publishGitInit(stage: GitInitStage, request: GitInitRequest, identity: string, result: { head: string; fingerprint: string }) {
  const { files, fingerprint } = validateMetadata(stage.metadata, request, result.head);
  if (fingerprint !== result.fingerprint || inspectGitInitTarget(request.repository) !== identity) throw new Error("Repository or initialization metadata changed; nothing published");
  const target = join(request.repository, ".git");
  // Exclusive creation reserves the exact destination. Leave partial metadata on
  // I/O failure for inspection; never overwrite it or silently retry initialization.
  mkdirSync(target, { mode: 0o700 });
  const reserved = lstatSync(target);
  try {
    for (const [path, entry] of files) {
      for (let parent = dirname(join(target, path)); parent !== request.repository; parent = dirname(parent)) {
        if (absent(parent)) continue;
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || realpathSync(parent) !== parent || (parent === target && (stat.dev !== reserved.dev || stat.ino !== reserved.ino))) throw new Error("Initialization destination changed");
      }
      mkdirSync(dirname(join(target, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(target, path), entry.bytes, { flag: "wx", mode: entry.mode });
    }
    return { repository: request.repository, branch: request.branch, head: result.head, remote: request.remote, url: request.url,
      notice: "New repository with an empty root commit. Existing files remain untracked; no source history or global configuration changed. No push performed." };
  } catch (error) { throw new Error(`Git initialization publication failed; partial metadata may exist at ${target}. Inspect before any retry.`, { cause: error }); }
}
