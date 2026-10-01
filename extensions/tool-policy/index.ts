// Trusted host broker: all file operations execute in Codex; unsupported tools fail closed.
import { runProcess } from "../../lib/process.ts";
import { CONFINED_TOOLS } from "../../lib/confined-tools.ts";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  getAgentDir, getPackageDir, SettingsManager, withFileMutationQueue,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { registerNetworkAccess } from "./network.ts";

// Dunst is never delegated as a confined tool: its own bridge requires human approval per host action.
export const STRICT_TOOLS = new Set([...CONFINED_TOOLS, "dunst"]);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const factories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition];

export async function runSandboxTool(launcher: string, worker: string, sdk: string, cwd: string, request: unknown, signal?: AbortSignal) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new Error("Sandbox tool request exceeds 32 MiB");
  const output = await runProcess(launcher, ["-c", `${quote(process.execPath)} ${quote(worker)} ${quote(sdk)}`], {
    cwd, signal, input, timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024,
  });
  const result = JSON.parse(output);
  if (!Array.isArray(result.content)) throw new Error("Invalid sandbox tool result");
  return result;
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const launcher = join(agentDir, "scripts/codex-shell.mjs");
  const worker = join(agentDir, "scripts/codex-tool.mjs");
  const sdk = join(getPackageDir(), "dist/index.js");
  let loadedShell: string | undefined;
  let root: string | undefined;
  const shell = (ctx: ExtensionContext) => {
    const settings = SettingsManager.create(ctx.cwd);
    const value = ctx.isProjectTrusted() ? settings.getShellPath() : settings.getGlobalSettings().shellPath;
    return value ? resolve(value.replace(/^~\//, `${homedir()}/`)) : undefined;
  };
  const verify = (ctx: ExtensionContext) => {
    if (ctx.isProjectTrusted()) throw new Error("Strict sandbox requires untrusted project resources. Restart Pi with --no-approve; do not load project extensions on the host.");
    if (!root || realpathSync(ctx.cwd) !== root || loadedShell !== launcher || shell(ctx) !== launcher) {
      throw new Error("Strict sandbox not loaded or shellPath/cwd changed. Install the Codex adapter and restart Pi. No unrestricted fallback.");
    }
    for (const path of [agentDir, launcher, worker, sdk]) {
      const rel = relative(root, realpathSync(path));
      if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) {
        throw new Error("Sandbox runtime/configuration must live outside the writable workspace.");
      }
    }
  };
  registerNetworkAccess(pi, agentDir, verify);
  // Never load executable project resources from the writable side of the boundary.
  pi.on("project_trust", () => ({ trusted: "no" }));
  pi.on("session_start", (_event, ctx) => {
    root = realpathSync(ctx.cwd);
    loadedShell = shell(ctx);
  });
  pi.on("session_shutdown", () => { root = loadedShell = undefined; });
  pi.on("tool_call", (event, ctx) => {
    if (!STRICT_TOOLS.has(event.toolName)) return { block: true, reason: `Strict sandbox: ${event.toolName} has no confined executor; denied without approval or exception.` };
    try { verify(ctx); } catch (error) { return { block: true, reason: (error as Error).message }; }
  });
  for (const factory of factories) {
    const tool = factory(process.cwd());
    pi.registerTool({
      ...tool,
      async execute(id: string, input: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        verify(ctx);
        const run = () => runSandboxTool(launcher, worker, sdk, ctx.cwd, { name: tool.name, id, input }, signal);
        // ponytail: serialize file calls per workspace; per-file queues if contention matters.
        return withFileMutationQueue(ctx.cwd, run);
      },
    } as ToolDefinition);
  }
  pi.on("before_agent_start", event => {
    pi.setActiveTools(pi.getActiveTools().filter(name => STRICT_TOOLS.has(name)));
    event.systemPromptOptions.sections.confined_tools = "File tools, Bash, Notes, Graphify, Git inspection, LSP, local MCP servers, CI queries and web helpers execute inside Codex's OS sandbox. Writes: current workspace and private TMPDIR; outside reads allowed. Only the fixed Notes worker can also write project note storage, its Git exclude entry and the central notes.db with SQLite sidecars. Network is restricted to approved public hosts; request_network_access never disables filesystem confinement. Subagents inherit active confined tools without recursion or cwd widening; their model transport and private session artifacts remain host-side. Dunst is separate host automation, not confined: every operation requires explicit interactive human confirmation and it is never delegated. MCP only accepts trusted local stdio definitions, not remote server URLs. Other tools without executors are denied. Never retry a sandbox denial through an unrestricted tool.";
  });
  pi.registerCommand("confined-tools", {
    description: "Show confined executors and the separately approved Dunst host tool",
    handler: async (_args, ctx) => {
      try { verify(ctx); ctx.ui.notify(`Strict sandbox configured: ${[...CONFINED_TOOLS].join(", ")}. Other tools denied except Dunst. Additional public network hosts require approval. Dunst is host-side and requires human confirmation for each operation. Restart required after installation.`, "info"); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
