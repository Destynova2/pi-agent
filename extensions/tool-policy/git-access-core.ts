import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../lib/process.ts";

export interface GitRequest {
  operation: "branch" | "stage" | "commit" | "push";
  branch?: string;
  paths?: string[];
  message?: string;
  remote?: string;
  reason: string;
}
export interface GitSnapshot {
  root: string;
  gitDir: string;
  commonDir: string;
  identity: string;
  stamp: string;
  head: string;
  branch: string | null;
  staged: string[];
  remoteUrl?: string;
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
const control = /[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u;

export function validateGitRequest(value: unknown): GitRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error("Invalid or oversized Git request");
  const input = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { branch: ["branch"], stage: ["paths"], commit: ["paths", "message"], push: ["remote", "branch"] };
  if (typeof input.operation !== "string" || !Object.hasOwn(fields, input.operation)) throw new Error("Only branch, stage, commit and push are supported");
  const required = fields[input.operation];
  if (Object.keys(input).some(key => !["operation", "reason", ...required].includes(key)) || required.some(key => !(key in input))) throw new Error("Invalid fields for Git operation");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 || control.test(input.reason)) throw new Error("A short justification without control characters is required");
  if (input.branch !== undefined && (typeof input.branch !== "string" || input.branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) || input.branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) || input.branch.includes("..") || input.branch.endsWith("."))) throw new Error("Expected a literal branch name, not flags or a revision expression");
  if (input.remote !== undefined && (typeof input.remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.remote))) throw new Error("Expected a configured remote name, not a URL or flags");
  if (input.message !== undefined && (typeof input.message !== "string" || !input.message.trim() || input.message.length > 8000 || control.test(input.message.replaceAll("\n", "")))) throw new Error("Invalid commit message");
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 100) throw new Error("Name 1–100 explicit files, never a directory or all files");
    for (const path of input.paths) {
      if (typeof path !== "string" || !path || path.length > 1024 || control.test(path) || path.includes("\\") || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Expected literal repository-relative file paths");
    }
    if (new Set(input.paths).size !== input.paths.length) throw new Error("Duplicate paths are not allowed");
  }
  return JSON.parse(JSON.stringify(input)) as GitRequest;
}

export function gitRepositoryRoot(cwd: string): string {
  let root = realpathSync(cwd);
  while (!existsSync(join(root, ".git"))) {
    if (dirname(root) === root) throw new Error("No Git repository found");
    root = dirname(root);
  }
  return root;
}

function regular(path: string, limit: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || realpathSync(path) !== path) throw new Error("Linked, special or oversized Git input; no operation performed");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size !== stat.size || fstatSync(fd).ctimeMs !== stat.ctimeMs) throw new Error("Git input changed while reading; no operation performed");
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|TRACE.*|NAMESPACE|CEILING_DIRECTORIES|EXEC_PATH|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/.test(key) && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key)) env[key] = undefined;
  // Do not disable hooks, signing, clean/smudge filters, or repository checks.
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "/usr/bin/false", GIT_SEQUENCE_EDITOR: "/usr/bin/false", LC_ALL: "C" };
}

async function git(cwd: string, args: string[], signal?: AbortSignal, input?: string, env: NodeJS.ProcessEnv = {}) {
  return runProcess("/usr/bin/git", ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, signal, input, env: { ...gitEnv(), ...env }, timeoutMs: 300_000, graceMs: 250, maxBytes: 4 * 1024 * 1024 });
}

/** Runs inside Codex, including configuration-dependent filters or helpers. */
export async function inspectGit(cwd: string, request: GitRequest, signal?: AbortSignal): Promise<GitSnapshot> {
  const root = realpathSync(await git(cwd, ["rev-parse", "--show-toplevel"], signal));
  if (!inside(root, realpathSync(cwd))) throw new Error("Git repository does not contain the current workspace");
  const gitDir = realpathSync(await git(root, ["rev-parse", "--absolute-git-dir"], signal));
  const commonDir = realpathSync(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal));
  const marker = join(root, ".git"), markerStat = lstatSync(marker);
  if (markerStat.isDirectory()) {
    if (realpathSync(marker) !== marker || gitDir !== marker || commonDir !== marker) throw new Error("Unexpected Git metadata layout");
  } else {
    const text = regular(marker, 4096)?.toString("utf8").trim();
    if (!text?.startsWith("gitdir: ") || resolve(root, text.slice(8)) !== gitDir || dirname(gitDir) !== join(commonDir, "worktrees") || regular(join(gitDir, "gitdir"), 4096)?.toString("utf8").trim() !== marker) throw new Error("Unsupported or redirected worktree metadata");
  }
  for (const directory of [gitDir, commonDir]) if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Linked Git metadata is not supported");
  if (request.operation === "commit" && ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].some(name => existsSync(join(gitDir, name)))) throw new Error("An unfinished Git operation requires manual review; no commit performed");
  const headText = regular(join(gitDir, "HEAD"), 4096)?.toString("utf8").trim() ?? "";
  const branch = headText.startsWith("ref: refs/heads/") ? headText.slice(16) : null;
  if (!branch && request.operation !== "branch") throw new Error("A local branch is required; detached HEAD is refused");
  const head = await git(root, ["rev-parse", "--revs-only", "HEAD"], signal);
  if (head && !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid repository HEAD");
  if (request.branch) await git(root, ["check-ref-format", "--branch", request.branch], signal);
  const staged = (await git(root, ["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--"], signal)).split("\0").filter(Boolean).sort();
  if (request.operation === "commit" && JSON.stringify(staged) !== JSON.stringify([...request.paths!].sort())) throw new Error("The index does not match the explicit commit paths; inspect existing staged changes, never include another agent's files");
  const files: (string | null)[] = [];
  for (const path of request.paths ?? []) {
    const absolute = join(root, path);
    for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
      if (!inside(root, parent)) throw new Error("Path outside repository");
      try { if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new Error("Linked or non-directory parent"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const bytes = regular(absolute, 32 * 1024 * 1024);
    files.push(bytes === null ? null : sha(bytes));
  }
  const config = await git(root, ["config", "--null", "--show-origin", "--list"], signal);
  let remoteUrl: string | undefined;
  if (request.operation === "push") {
    if (/(?:^|\0)(?:remote\.[^\n]+\.vcs|push\.pushoption)\n/i.test(config)) throw new Error("Push requires standard HTTPS transport without custom VCS helpers or configured push options");
    if (!head) throw new Error("Nothing committed to push");
    remoteUrl = await git(root, ["remote", "get-url", "--push", "--all", request.remote!], signal);
    const url = new URL(remoteUrl);
    if (remoteUrl.includes("\n") || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new Error("Push requires exactly one HTTPS destination without embedded credentials; no SSH, local transport or external remote helper");
    remoteUrl = url.href;
  }
  const index = regular(join(gitDir, "index"), 64 * 1024 * 1024);
  const identity = sha(JSON.stringify(["git-access-v1", root, ...[gitDir, commonDir].map(path => { const stat = lstatSync(path); return [path, stat.dev, stat.ino, stat.birthtimeMs]; })]));
  return { root, gitDir, commonDir, identity, stamp: sha(JSON.stringify([identity, headText, head, index && sha(index), sha(config), files, remoteUrl])), head, branch, staged, remoteUrl };
}

/** Only mutable Git data. Config, hooks, credentials and other worktrees stay read-only. */
export function gitWritePaths(snapshot: GitSnapshot, request: GitRequest): string[] {
  const { gitDir, commonDir } = snapshot;
  const paths = request.operation === "stage" ? [join(gitDir, "index"), join(gitDir, "index.lock"), join(commonDir, "objects")]
    : request.operation === "commit" ? [join(gitDir, "index"), join(gitDir, "index.lock"), join(gitDir, "HEAD.lock"), join(gitDir, "COMMIT_EDITMSG"), join(commonDir, "objects"), join(commonDir, "refs/heads"), join(commonDir, "logs"), join(gitDir, "logs")]
    : request.operation === "branch" ? [join(gitDir, "HEAD"), join(gitDir, "HEAD.lock"), join(gitDir, "index"), join(gitDir, "index.lock"), join(commonDir, "refs/heads"), join(commonDir, "logs"), join(gitDir, "logs")]
    : [join(commonDir, "refs/remotes"), join(commonDir, "logs/refs/remotes")];
  return [...new Set(paths)];
}

export function gitOperationArgs(request: GitRequest, snapshot: GitSnapshot): string[] {
  switch (request.operation) {
    case "branch": return ["switch", "--no-track", "-c", request.branch!];
    case "stage": return ["--literal-pathspecs", "add", "--", ...request.paths!];
    case "commit": return ["commit", "--file=-"];
    // Use the reviewed object ID, never a moving HEAD, implicit refspec, tags or force.
    case "push": return ["-c", `remote.${request.remote}.mirror=false`, "push", "--no-force", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--", request.remote!, `${snapshot.head}:refs/heads/${request.branch}`];
  }
}

export async function performGit(cwd: string, request: GitRequest, expected: GitSnapshot, signal?: AbortSignal) {
  const current = await inspectGit(cwd, request, signal);
  if (current.stamp !== expected.stamp || current.identity !== expected.identity) throw new Error("Git state changed during approval; no operation performed");
  if (request.operation === "commit") await git(current.root, ["diff", "--cached", "--check"], signal);
  const tree = request.operation === "commit" ? await git(current.root, ["write-tree"], signal) : undefined;
  const args = gitOperationArgs(request, current), env: NodeJS.ProcessEnv = {};
  if (tree !== undefined) {
    const hooks = fileURLToPath(new URL("../../scripts/git-hooks/", import.meta.url));
    for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"]) {
      if (!regular(join(hooks, name), 4096)) throw new Error("Missing Git hook gate");
      accessSync(join(hooks, name), constants.X_OK);
    }
    env.PI_GIT_ACCESS_NODE = process.execPath;
    env.PI_GIT_ACCESS_GUARD = fileURLToPath(new URL("../../scripts/git-hook-guard.mjs", import.meta.url));
    env.PI_GIT_ACCESS_ORIGINAL_HOOKS = resolve(current.root, await git(current.root, ["rev-parse", "--git-path", "hooks"], signal));
    env.PI_GIT_ACCESS_EXPECTED_TREE = tree;
    env.PI_GIT_ACCESS_EXPECTED_HEAD = current.head;
    env.PI_GIT_ACCESS_EXPECTED_REF = `refs/heads/${current.branch}`;
    args.unshift("-c", `core.hooksPath=${hooks}`);
  }
  await git(current.root, args, signal, request.message, env);
  const head = await git(current.root, ["rev-parse", "--revs-only", "HEAD"], signal);
  const hooksChangedTree = tree !== undefined && tree !== await git(current.root, ["rev-parse", "HEAD^{tree}"], signal);
  return { operation: request.operation, head, hooksChangedTree, notice: hooksChangedTree ? "Commit created, but its tree differs from the reviewed index (hook or concurrent changes). Inspect it before any push; do not retry the commit." : "Git command completed. Inspect the result; this is not proof of CI or application health." };
}
