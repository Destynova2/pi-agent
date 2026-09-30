import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// shellPath is also consumed by pi-background-bash. Refuse project overrides rather than
// silently switching that package's cached shell back to an unrestricted executable.
export default function (pi: ExtensionAPI) {
  const launcher = join(getAgentDir(), "scripts/codex-shell.mjs");
  let enabled = false;
  let loadedShell: string | undefined;
  const shellPath = (ctx: ExtensionContext) => {
    const settings = SettingsManager.create(ctx.cwd);
    const global = settings.getGlobalSettings();
    const normalize = (path: string | undefined) => path ? resolve(path.replace(/^~\//, `${homedir()}/`)) : undefined;
    enabled = normalize(global.shellPath) === launcher;
    const trusted = ctx.isProjectTrusted();
    return normalize(trusted ? settings.getShellPath() : global.shellPath);
  };
  pi.on("session_start", (_event, ctx) => { loadedShell = shellPath(ctx); });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "subagent") return;
    try {
      const current = shellPath(ctx);
      if (!enabled) return;
      if (current !== launcher || loadedShell !== launcher) {
        return { block: true, reason: "Codex sandbox shell is not loaded or a project shellPath overrides it. Remove that override and reload Pi while idle. No unsandboxed execution permitted." };
      }
      realpathSync(launcher); // A missing adapter must fail closed too.
      if (event.toolName === "subagent") {
        const input = event.input as { cwd?: unknown; tasks?: unknown; chain?: unknown };
        const scopes: unknown[] = [input, ...(Array.isArray(input.tasks) ? input.tasks : []), ...(Array.isArray(input.chain) ? input.chain : [])];
        const root = realpathSync(ctx.cwd);
        for (const scope of scopes) {
          if (!scope || typeof scope !== "object" || !("cwd" in scope) || scope.cwd === undefined) continue;
          if (typeof scope.cwd !== "string") return { block: true, reason: "Sandbox child cwd must be a directory path." };
          const rel = relative(root, realpathSync(resolve(ctx.cwd, scope.cwd)));
          if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
            return { block: true, reason: "Sandbox delegation must stay inside the current working directory; a child cannot widen its parent's filesystem scope." };
          }
        }
      }
    } catch (error) {
      return { block: true, reason: `Cannot verify Codex sandbox shell: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.on("before_agent_start", (event) => {
    if (enabled) event.systemPromptOptions.sections.codex_sandbox = "Bash uses the Codex macOS sandbox: writes only in the session working directory and a private per-project TMPDIR; .git/.codex/.agents are protected; network is disabled. Reads outside the project remain possible. Do not retry a denied command outside the sandbox or use another tool to bypass it. Report needed access instead. File tools, LSP and extension internals are not confined by this shell adapter.";
  });
  pi.registerCommand("codex-sandbox", {
    description: "Show whether the Codex shell adapter was loaded",
    handler: async (_args, ctx) => {
      const current = shellPath(ctx);
      ctx.ui.notify(`Codex shell sandbox: ${enabled && loadedShell === launcher && current === launcher ? "configured at session load" : "not loaded / overridden"}\nShell: ${loadedShell ?? "default"}\nWorking directory: ${ctx.cwd}\nWrites: working directory + private TMPDIR. Network: blocked. Outside reads: allowed.\nThis covers Bash, not every Pi tool. Old sessions require an idle reload.`, "info");
    },
  });
}
