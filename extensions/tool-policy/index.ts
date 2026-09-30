// Trusted host broker: all file operations execute in Codex; unsupported tools fail closed.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  getAgentDir, getPackageDir, SettingsManager, withFileMutationQueue,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerNetworkAccess } from "./network.ts";

export const STRICT_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep", "bash", "bash_process", "request_network_access"]);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const factories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition];

export function runSandboxTool(launcher: string, worker: string, sdk: string, cwd: string, request: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) return Promise.reject(new Error("Sandbox tool aborted"));
  return new Promise((done, fail) => {
    const child = spawn(launcher, ["-c", `${quote(process.execPath)} ${quote(worker)} ${quote(sdk)}`], {
      cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const abort = () => stop(new Error("Sandbox tool aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Sandbox tool timed out (60s)")), 60_000);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (chunks: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) stop(new Error("Sandbox tool output exceeds 32 MiB"));
      else chunks.push(data);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) return fail(failure);
      if (code !== 0) return fail(new Error(`Sandbox tool failed (${code}): ${Buffer.concat(stderr).toString().slice(0, 8000)}`));
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString());
        if (!Array.isArray(result.content)) throw new Error("Invalid sandbox tool result");
        done(result);
      } catch (error) { fail(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
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
      async execute(id, input, signal, _onUpdate, ctx) {
        verify(ctx);
        const run = () => runSandboxTool(launcher, worker, sdk, ctx.cwd, { name: tool.name, id, input }, signal);
        // ponytail: serialize file calls per workspace; per-file queues if contention matters.
        return withFileMutationQueue(ctx.cwd, run);
      },
    } as any);
  }
  pi.on("before_agent_start", event => {
    pi.setActiveTools(pi.getActiveTools().filter(name => STRICT_TOOLS.has(name)));
    event.systemPromptOptions.sections.tool_policy = "Strict tool sandbox: file tools and Bash execute inside Codex's OS sandbox. Writes: current workspace and private TMPDIR only; outside reads allowed. Network is restricted to approved hosts through Codex's managed proxy. request_network_access can ask the human for an additional public host, never for filesystem escape. All other tools (including LSP, subagent, MCP, web and shared notes) are denied. No tool-policy.json exceptions or automatic escalation. Model transport, session storage and trusted extension lifecycle code remain host-side.";
  });
  pi.registerCommand("tool-policy", {
    description: "Show sandbox status (only additional network hosts require approval)",
    handler: async (_args, ctx) => {
      try { verify(ctx); ctx.ui.notify(`Strict sandbox configured: ${[...STRICT_TOOLS].join(", ")}. Other tools denied. Only additional public network hosts can request approval. Restart required after installation.`, "info"); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
