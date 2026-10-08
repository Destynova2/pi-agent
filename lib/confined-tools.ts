// Trusted executors only. This is not a configurable allow/ask/deny policy.
export const CONFINED_TOOLS = new Set([
  "read", "write", "edit", "ls", "find", "grep", "bash", "bash_background", "bash_process", "request_network_access",
  "note_add", "note_list", "project_graph", "git_inspect", "web_fetch", "web_search", "ci_watch", "lsp", "mcp", "subagent",
]);
