// Exact tool-name authorization policy (allow | ask | deny | task), read from the trusted
// Pi agent directory. Never from the repository, the environment or model input.
// This is a tool-call gate, not an OS sandbox: an allowed shell tool can still do anything.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ToolAction = "allow" | "ask" | "deny" | "task";
export type ToolPolicy = Readonly<Record<string, ToolAction>>;

export const TOOL_POLICY_FILE = "tool-policy.json";
export const MAX_POLICY_BYTES = 64 * 1024;
const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny", "task"]);
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name) && !FORBIDDEN_KEYS.has(name);
}

function freezePolicy(entries: Iterable<[string, ToolAction]>): ToolPolicy {
  const out: Record<string, ToolAction> = Object.create(null);
  for (const [name, action] of entries) out[name] = action;
  if (!Object.hasOwn(out, "*")) out["*"] = "ask";
  return Object.freeze(out);
}

/** Built-in snapshot used when <agentDir>/tool-policy.json is absent. Identity marks "built-in". */
export const DEFAULT_TOOL_POLICY: ToolPolicy = freezePolicy(
  ["read", "grep", "find", "ls", "edit", "write", "note_list", "note_add", "project_graph", "git_inspect", "subagent"]
    .map((name): [string, ToolAction] => [name, "allow"]),
);

function readBounded(path: string): string | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlinked policy file fails with ELOOP instead of being followed.
    // O_NONBLOCK: a FIFO opens immediately (then fails the regular-file check) instead of hanging.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${path}: symlinks are not accepted`);
    throw new Error(`${path}: unreadable (${code ?? String(error)})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path}: not a regular file`);
    if (stat.size > MAX_POLICY_BYTES) throw new Error(`${path}: larger than ${MAX_POLICY_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let length = 0;
    for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n;
    if (length > MAX_POLICY_BYTES) throw new Error(`${path}: larger than ${MAX_POLICY_BYTES} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads ONLY <agentDir>/tool-policy.json. Absent: built-in policy. Present: full replacement
 * (missing "*" means ask). Any malformed, unreadable, symlinked or oversized file throws.
 */
export function loadToolPolicy(agentDir: string): ToolPolicy {
  if (typeof agentDir !== "string" || agentDir === "") throw new Error("tool policy: agent directory is required");
  const path = join(agentDir, TOOL_POLICY_FILE);
  const text = readBounded(path);
  if (text === undefined) return DEFAULT_TOOL_POLICY;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
    throw new Error(`${path}: expected a JSON object mapping tool names to "allow" | "ask" | "deny" | "task"`);
  }
  const entries: [string, ToolAction][] = [];
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== "string" || (key !== "*" && !isValidToolName(key))) {
      throw new Error(`${path}: invalid tool name ${JSON.stringify(String(key))}`);
    }
    const action = (Object.getOwnPropertyDescriptor(data, key) as PropertyDescriptor).value;
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      throw new Error(`${path}: invalid action for ${JSON.stringify(key)} (expected "allow", "ask", "deny" or "task")`);
    }
    entries.push([key, action as ToolAction]);
  }
  return freezePolicy(entries);
}

/** Exact own-key lookup, falling back to "*" then "ask". Invalid names never hit a named entry. */
export function toolDecision(policy: ToolPolicy, toolName: string): ToolAction {
  const pick = (key: string): ToolAction | undefined => {
    if (!Object.hasOwn(policy, key)) return undefined;
    const action = policy[key];
    return ACTIONS.has(action) ? action : "deny";
  };
  return (isValidToolName(toolName) ? pick(toolName) : undefined) ?? pick("*") ?? "ask";
}

/** Built-in tools whose input.path is a file mutation target; never allowed inside the agent directory. */
export const PATH_GUARDED_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Mirrors Pi's resolveToCwd (utils/paths.js): unicode spaces, leading @, ~, file://, MSYS drives, cwd. */
export function resolveLikePi(input: string, cwd: string): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (process.platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) p = join(homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Real path of an existing entry, or of its nearest existing ancestor + the missing tail. Throws when unresolvable. */
export function canonical(path: string): string {
  const tail: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      tail.unshift(basename(current));
      continue;
    }
    // realpath throws on a dangling symlink: writing through it would land at an unchecked target.
    return join(realpathSync(current), ...tail);
  }
}

export function inside(root: string, target: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const rel = fold ? relative(root.toLowerCase(), target.toLowerCase()) : relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Why an edit/write to rawPath must be blocked, or undefined when it may proceed.
 * Blocks targets inside agentDir (lexically or after resolving symlinks, including symlinked
 * ancestors of not-yet-existing files) and any missing, invalid or unresolvable path.
 * ponytail: check-then-write race (a concurrent same-user process can swap a symlink); OS sandbox if that matters.
 */
export function protectedPathViolation(agentDir: string, rawPath: unknown, cwd: unknown): string | undefined {
  if (typeof rawPath !== "string" || rawPath.trim() === "" || rawPath.includes("\0")) return "missing or invalid path";
  if (typeof cwd !== "string" || cwd === "") return "working directory unknown";
  try {
    const target = resolveLikePi(rawPath, cwd);
    const root = resolve(agentDir);
    let realRoot = root;
    try { realRoot = realpathSync(root); } catch { /* agent dir absent: lexical check only */ }
    const realTarget = canonical(target);
    if ([root, realRoot].some((r) => inside(r, target) || inside(r, realTarget))) return `inside the protected agent directory ${root}`;
    return undefined;
  } catch (error) {
    return `path cannot be resolved (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
}
