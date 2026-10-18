import { runtimeRoot } from "../../lib/runtime-paths.mjs";
// Trusted host broker: all file operations execute in Codex; unsupported tools fail closed.
import { runProcess } from "../../lib/process.ts";
import { CONFINED_TOOLS, observeFile, readBeforeEdit } from "../../lib/confined-tools.ts";
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
import { registerCommandAccess } from "./command-access.ts";
import { registerIsolatedCommand } from "./isolated-command.ts";
import { registerHostAccess } from "./host-access.ts";
import { registerBuildAccess } from "./build-access.ts";
import { registerPodmanAccess } from "./podman-access.ts";
import { registerGitAccess } from "./git-access.ts";
import { registerGitInit } from "./git-init.ts";
import { registerGitWorktree } from "./git-worktree.ts";
import { registerJjCheckpoint } from "./jj-checkpoint.ts";
import { registerHarnessUpdate } from "./harness-update.ts";
import { registerApprovalReview } from "../../lib/approval-review.ts";

// Approval bridges are parent-only: neither host automation nor filesystem grants are delegated.
export const STRICT_TOOLS = new Set([...CONFINED_TOOLS, "run_isolated", "request_command_access", "request_host_access", "request_build_access", "request_podman_access", "model_catalog", "git_access", "git_repository_init", "git_worktree_cleanup", "jj_checkpoint", "task_checkpoint", "load_tools", "harness_update"]);
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
  const launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const worker = join(runtimeRoot, "scripts/codex-tool.mjs");
  const sdk = join(getPackageDir(), "dist/index.js");
  let loadedShell: string | undefined;
  let root: string | undefined;
  const shell = (ctx: ExtensionContext) => {
    const settings = SettingsManager.create(ctx.cwd);
    const value = ctx.isProjectTrusted() ? settings.getShellPath() : settings.getGlobalSettings().shellPath;
    return value ? resolve(value.replace(/^~\//, `${homedir()}/`)) : undefined;
  };
  const verify = (ctx: ExtensionContext) => {
    if (ctx.isProjectTrusted()) throw new Error("Strict sandbox requires a fresh untrusted runtime. Restart Pi with --no-approve (the managed launcher adds it); /reload cannot undo previously loaded project extensions.");
    if (!root || realpathSync(ctx.cwd) !== root || loadedShell !== launcher || shell(ctx) !== launcher) {
      throw new Error("Strict sandbox not loaded or shellPath/cwd changed. Install the Codex adapter and restart Pi. No unrestricted fallback.");
    }
    for (const path of [agentDir, runtimeRoot, launcher, worker, sdk]) {
      const rel = relative(root, realpathSync(path));
      if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) {
        throw new Error("Sandbox runtime/configuration must live outside the writable workspace.");
      }
    }
  };
  registerNetworkAccess(pi, agentDir, verify);
  registerApprovalReview(pi, agentDir, verify);
  // Never load executable project resources from the writable side of the boundary.
  pi.on("project_trust", () => ({ trusted: "no" }));
  pi.on("session_start", (_event, ctx) => {
    root = realpathSync(ctx.cwd);
    loadedShell = shell(ctx);
  });
  pi.on("session_shutdown", () => { root = loadedShell = undefined; });
  const observed = new Set<string>();
  // File knowledge is physical, so a fork keeps it; another session, branch, compaction or shutdown does not.
  for (const event of ["session_start", "session_before_switch", "session_before_tree", "session_compact", "session_shutdown"] as const) pi.on(event, () => observed.clear());
  pi.on("tool_call", (event, ctx) => {
    if (!STRICT_TOOLS.has(event.toolName)) return { block: true, reason: `Strict sandbox: ${event.toolName} has no confined executor; denied without approval or exception.` };
    try { verify(ctx); } catch (error) { return { block: true, reason: (error as Error).message }; }
    const reason = readBeforeEdit(observed, event.toolName, event.input, ctx.cwd);
    if (reason) return { block: true, reason };
  });
  pi.on("tool_result", (event, ctx) => { observeFile(observed, event.toolName, event.input, ctx.cwd, event.isError); });
  registerCommandAccess(pi, agentDir, verify);
  registerIsolatedCommand(pi, agentDir, verify);
  registerHostAccess(pi, agentDir, verify);
  registerBuildAccess(pi, agentDir, verify);
  registerPodmanAccess(pi, agentDir, verify);
  registerHarnessUpdate(pi, agentDir, verify);
  registerGitAccess(pi, agentDir, verify);
  registerGitInit(pi, agentDir, verify);
  registerGitWorktree(pi, agentDir, verify);
  registerJjCheckpoint(pi, agentDir, verify);
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
    event.systemPromptOptions.sections.worktree_cleanup = "For requested worktree cleanup, use git_worktree_cleanup inspect, then remove for explicit existing paths or prune for explicit missing registrations. Its one-time approval archives files and metadata, preserves branches and pins commits; no push-or-discard decision is needed simply to remove a worktree. Never purge archives or delete branches implicitly. Use git_access for separately authorized commits/pushes: up to 1000 explicit files, with complete paginated approval when necessary. Propose logical commit groups based on ownership and purpose, then ask only for a genuinely missing decision. Do not end with a manual command when an available approval tool can perform the authorized operation. A capability gap requires a concrete alternative or reviewed source change, never self-authorization or an unrestricted shell.";
    event.systemPromptOptions.sections.podman_bridge = "request_podman_access runs generic Podman engine commands (including build) through the protected host CLI and the default local connection. Every exact argv/connection uses /approvals or human consent unless the user explicitly saved engine-wide project access at a repeated prompt. That project/connection grant survives restart and skips further confirmations and automatic review in interactive sessions; without UI a configured automatic policy and fresh exact review are required; /podman-access permissions revokes it. Only the human can select it; automatic approvals never create it. Use the tool directly for authorized container work. Bash and cargo xtask stay sandboxed; this tool is not a shell or a W4re adapter. No compose, machine SSH, host helpers or client file transfers. Inspect partial effects before retrying; successful execution does not prove application health.";
    pi.setActiveTools(pi.getActiveTools().filter(name => STRICT_TOOLS.has(name)));
    event.systemPromptOptions.sections.git_initialization = "For an authorized separate repository with empty main and populated develop, use git_repository_init after preparing a destination directory. It creates an empty root commit, explicit local identity and one HTTPS remote without replacing existing metadata or importing source history. Then use git_access with repository for branch/stage/commit. For publication, each push needs exact consent; source_branch=main selects the empty main even while develop is checked out. Inspect remote/source freshness and reviewed content independently: initialization does not fetch or validate remote access. /git-init reset cancels pending initialization. Only the parent has this capability; without UI it requires a configured automatic review policy.";
    event.systemPromptOptions.sections.confined_tools = "File tools, Bash, Notes, Graphify, Git inspection, LSP, ordinary local MCP servers, CI queries and web helpers execute inside Codex's OS sandbox: writes only in the current workspace and the private TMPDIR, reads outside allowed. The fixed Notes worker can also write project note storage, its Git exclude entry and the central notes.db with SQLite sidecars. Other tools without executors are denied. Never retry a sandbox denial through an unrestricted tool; request only an explicitly supported capability and continue independent authorized work. Capabilities are parent-only and never reach subagents; subagents inherit the active confined tools without recursion or cwd widening, and their model transport and private session artifacts remain host-side. Dunst remains denied by the local strict dispatcher, including in the interactive parent; never use it as a Git workaround. Rarely needed capabilities (host, Podman, build, repository init, worktree cleanup, model catalog, isolated runs, harness update) stay dormant until load_tools declares them. Approvals: the user can configure /approvals auto <scope> or auto-deny <scope> for this project; eligible confirmations then use a separate reviewer, and auto-deny refuses uncertainty without a dialog. Configured automatic policies also permit fresh headless parent review for supported host, Podman, build, Git, worktree and checkpoint operations; saved broad human grants alone do not enable headless host execution. Legacy approvals default to manual; the two one-command capabilities use task review. Use the capability tools normally without a redundant textual confirmation first. The main agent cannot approve itself, change this policy, or treat earlier automatic decisions as user consent. Missing capabilities call for a precise incident and a tested, reviewable source patch; never edit the active harness or approve its own expansion. Network is restricted to approved public hosts. request_network_access with command qualifies and executes one exact command with only its named hosts, saves no session grant and never disables filesystem confinement. git_access push with private_network=true grants only the configured remote DNS name for one operation, including private resolutions and all ports on that name; other hosts and direct sockets stay blocked. Use it only for an authorized push to a confirmed private destination, never to bypass explicit network denies. These capabilities qualify current user intent by default, with explicit project policies taking precedence. jj_checkpoint initialization needs one approval, later snapshots have separate revocable session/project consent; no automatic restoration. For authorized Git writes, use git_access directly: new branch, explicit-file staging and commit can share once/session/project consent; push always needs a separate exact approval; /git-access permissions revokes repository consent. Its fixed worker and hooks remain jailed; on Linux the parent publishes only validated, operation-specific metadata from a disposable Git copy under native locks, and real Git config, hooks and general Bash access remain protected. A stored permission does not itself request a commit or push. In the parent, including without UI when automatic review is configured, after a failed foreground Bash call request_command_access may request exact additional write paths and/or Metal GPU access when a reviewed backend has passed native qualification: the approval broker must approve the stored command/cwd/capabilities before one supervised rerun inside Codex. Additional filesystem rights remain one-command grants. In the interactive parent, GPU-only Metal requests offer revocable once/session/project consent bound to the qualified backend; /command-access permissions revokes it. Headless Metal always needs fresh configured automatic review. task_checkpoint is parent-only session metadata: it records requirements and evidence without command execution or granting permissions. MCP only accepts trusted local stdio definitions, not remote URLs. Servers only remember declared read-only tools; unknown or mutating operations require fresh exact approval. Annotations are unverified; remembered grants do not authorize sending messages or submitting forms without the user's explicit go for that exact action. An explicitly configured Playwright browser profile is a separate parent-only container capability: launch needs revocable project/session/once consent, uses a fixed local Podman container without host files, has its own network scope and opens no host listeners; its tools may have once/session/project consent per tool, including JavaScript and site interactions.";
  });
  pi.registerCommand("confined-tools", {
    description: "Show confined executors, one-command write approvals and blocked host automation",
    handler: async (_args, ctx) => {
      try { verify(ctx); ctx.ui.notify(`Strict sandbox configured: ${[...CONFINED_TOOLS].join(", ")}. Other tools denied except run_isolated, request_command_access, request_host_access, request_build_access, request_podman_access, git_access, git_repository_init, git_worktree_cleanup, jj_checkpoint, task_checkpoint session metadata and the read-only model_catalog snapshot. git_worktree_cleanup reviews exact paths, archives files and metadata, preserves branches and pins commits after one-time consent; /git-worktree reset cancels pending cleanup. git_access offers repository-scoped local Git consent, but each push needs its own approval; /git-access permissions revokes it. Additional filesystem paths or an installed, qualified Metal capability require approval of one exact failed command retry; additional public network hosts require approval. Metal is never enabled for ordinary Bash by installation or restart: use request_command_access with gpu=metal after a foreground failure. A nil device in ordinary Bash is expected. Dunst is host-side and remains denied in this jail. /dunst permissions and /mcp permissions revoke project consent. KVM image builds use request_build_access with explicit one-shot approval; /build-access reset cancels them. Restart required after installation.`, "info"); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
