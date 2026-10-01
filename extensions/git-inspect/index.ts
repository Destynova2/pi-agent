// Read-only git inspection with a fixed argv (no shell, no user-chosen args/revisions),
// so read-only agents can inspect a repository without general bash.
// Repo/user config cannot launch helpers: pager, external diff, textconv, fsmonitor,
// signature verification, submodule recursion and clean/smudge filters are disabled.
// Model calls also run this implementation inside the Codex sandbox.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringDecoder } from "node:string_decoder";
import { runProcess } from "../../lib/process.ts";
import { runConfined } from "../../lib/confined.ts";

export const MAX_OUTPUT_BYTES = 16 * 1024;
export const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 4096;
const TIMEOUT_MS = 15_000;
const PROCESS_MAX_BYTES = 4 * 1024 * 1024;

export const GitInspectParams = Type.Object({
  operation: Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("files")]),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }), {
    maxItems: MAX_PATHS, description: "Repo paths relative to the working directory (diff/files only)",
  })),
  staged: Type.Optional(Type.Boolean({ description: "diff only: show staged changes (index vs HEAD)" })),
}, { additionalProperties: false });
export type GitInspectInput = Static<typeof GitInspectParams>;

// The explicit flag also fails closed on Git versions that do not support disabling lazy fetch.
const GLOBAL_ARGS = ["--no-pager", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "color.ui=false"];

export function validatePaths(paths: unknown): string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw new Error(`paths must be an array of at most ${MAX_PATHS} strings`);
  return paths.map((path) => {
    if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) throw new Error("each path must be a non-empty string");
    if (path.includes("\0")) throw new Error("path contains NUL");
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) throw new Error(`absolute path refused: ${path}`);
    if (path.split(/[\\/]/).includes("..")) throw new Error(`path traversal refused: ${path}`);
    return path;
  });
}

/** Fixed argv per operation; user input only ever lands after `--` as literal pathspecs. */
export function buildArgs(input: GitInspectInput): string[] {
  const { operation, staged } = input;
  const paths = validatePaths(input.paths);
  if (paths.length && (operation === "status" || operation === "log")) throw new Error(`paths are only accepted for diff and files, not ${operation}`);
  if (staged !== undefined && operation !== "diff") throw new Error("staged is only accepted for diff");
  if (staged !== undefined && typeof staged !== "boolean") throw new Error("staged must be a boolean");
  switch (operation) {
    case "status": return [...GLOBAL_ARGS, "status", "--short", "--untracked-files=normal", "--ignore-submodules=all"];
    case "log": return [...GLOBAL_ARGS, "log", "--no-decorate", "-n", "20", "--oneline", "--no-show-signature"];
    case "diff": return [...GLOBAL_ARGS, "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules", ...(staged ? ["--cached"] : []), "--", ...paths];
    case "files": return [...GLOBAL_ARGS, "ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths];
    default: throw new Error(`unknown operation: ${String(operation)}`);
  }
}

function baseEnv(): NodeJS.ProcessEnv {
  // ctx.cwd decides the repository; inherited redirections must not.
  return { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };
}

/** Neutralizes every configured clean/smudge filter driver (they run on diff/status). */
async function filterOverrides(cwd: string, signal: AbortSignal | undefined): Promise<NodeJS.ProcessEnv> {
  const listing = await runProcess("git", [...GLOBAL_ARGS, "config", "-z", "--name-only", "--list"], {
    cwd, signal, timeoutMs: TIMEOUT_MS, maxBytes: PROCESS_MAX_BYTES, env: baseEnv(),
  });
  const drivers = new Set<string>();
  for (const key of listing.split("\0")) {
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (match) drivers.add(match[1]);
  }
  const env: NodeJS.ProcessEnv = {};
  let count = 0;
  for (const driver of drivers) {
    for (const [name, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
      env[`GIT_CONFIG_KEY_${count}`] = `filter.${driver}.${name}`;
      env[`GIT_CONFIG_VALUE_${count}`] = value;
      count++;
    }
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

export async function gitInspect(cwd: string, input: GitInspectInput, signal?: AbortSignal): Promise<string> {
  const args = buildArgs(input);
  const env = { ...baseEnv(), ...(await filterOverrides(cwd, signal)) };
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let total = 0;
  try {
    await runProcess("git", args, {
      cwd, signal, env, timeoutMs: TIMEOUT_MS, maxBytes: PROCESS_MAX_BYTES,
      onStdout: (chunk) => {
        total += chunk.length;
        if (keptBytes >= MAX_OUTPUT_BYTES) return;
        const part = chunk.subarray(0, MAX_OUTPUT_BYTES - keptBytes);
        kept.push(part);
        keptBytes += part.length;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git_inspect ${input.operation} failed: ${message}${/too large/.test(message) ? "\nNarrow the request with paths." : ""}`);
  }
  const decoder = new StringDecoder("utf8");
  const truncated = total > MAX_OUTPUT_BYTES;
  // write() withholds an incomplete trailing character; end() flushes only when nothing was cut.
  const text = (decoder.write(Buffer.concat(kept)) + (truncated ? "" : decoder.end())).trimEnd();
  if (!truncated) return text || "(no output)";
  return `${text}\n[output truncated: showed ${MAX_OUTPUT_BYTES} of ${total} bytes; narrow the request with paths]`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_inspect",
    label: "Git Inspect",
    description: "Read-only git inspection in the working directory. operation: status | diff (optional staged, paths) | log (last 20 commits) | files (tracked + untracked, optional paths). paths are literal, relative, no '..'. Output capped at 16 KiB.",
    parameters: GitInspectParams,
    execute: async (_id, params, signal, _onUpdate, ctx) => ({
      content: [{ type: "text", text: String(await runConfined(ctx.cwd, "git", params, signal ?? ctx.signal)) }],
      details: undefined,
    }),
  });
}
