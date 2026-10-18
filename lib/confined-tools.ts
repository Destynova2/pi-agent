import { resolve } from "node:path";

/**
 * Read-before-edit as a guard instead of a prompt rule: `edit` must follow a `read` (or `write`)
 * of the same file earlier in this session. Returns the block reason, or undefined to allow.
 */
export function readBeforeEdit(observed: Set<string>, toolName: string, input: unknown, cwd: string): string | undefined {
  const path = filePath(input);
  if (path && toolName === "edit" && !observed.has(resolve(cwd, path))) return `Read ${path} with the read tool before editing it in this session.`;
}

/** Call from tool_result: only a read or write that actually succeeded makes a file known. */
export function observeFile(observed: Set<string>, toolName: string, input: unknown, cwd: string, isError: boolean): void {
  const path = filePath(input);
  if (path && !isError && (toolName === "read" || toolName === "write")) observed.add(resolve(cwd, path));
}

const filePath = (input: unknown) => { const path = (input as { path?: unknown } | undefined)?.path; return typeof path === "string" && path ? path : undefined; };

// Trusted executors only. This is not a configurable allow/ask/deny policy.
export const CONFINED_TOOLS = new Set([
  "read", "write", "edit", "ls", "find", "grep", "bash", "bash_background", "bash_process", "request_network_access",
  "note_add", "note_list", "project_graph", "git_inspect", "web_fetch", "web_search", "ci_watch", "lsp", "mcp", "subagent",
]);
