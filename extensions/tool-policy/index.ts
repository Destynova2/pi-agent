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
import { registerCommandAccess } from "./command-access.ts";
import { registerHostAccess } from "./host-access.ts";
import { registerBuildAccess } from "./build-access.ts";
import { registerPodmanAccess } from "./podman-access.ts";
import { registerGitAccess } from "./git-access.ts";
import { registerJjCheckpoint } from "./jj-checkpoint.ts";
import { registerApprovalReview } from "../../lib/approval-review.ts";

// Approval bridges are parent-only: neither host automation nor filesystem grants are delegated.
export const STRICT_TOOLS = new Set([...CONFINED_TOOLS, "request_command_access", "request_host_access", "request_build_access", "request_podman_access", "model_catalog", "git_access", "jj_checkpoint", "task_checkpoint"]);
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
    if (ctx.isProjectTrusted()) throw new Error("Strict sandbox requires a fresh untrusted runtime. Restart Pi normally after installing the project-trust patch; /reload cannot undo previously loaded project extensions.");
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
  registerApprovalReview(pi, agentDir, verify);
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
  registerCommandAccess(pi, agentDir, verify);
  registerHostAccess(pi, agentDir, verify);
  registerBuildAccess(pi, agentDir, verify);
  registerPodmanAccess(pi, agentDir, verify);
  registerGitAccess(pi, agentDir, verify);
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
    event.systemPromptOptions.sections.podman_bridge = "request_podman_access runs generic Podman engine commands (including build) through the protected host CLI and the default local connection. Every exact argv/connection is approved once by /approvals or the human. Use it directly for authorized container work. Bash and cargo xtask stay sandboxed; this tool is not a shell or a W4re adapter. No compose, machine SSH, host helpers or client file transfers. Inspect partial effects before retrying; successful execution does not prove application health.";
    pi.setActiveTools(pi.getActiveTools().filter(name => STRICT_TOOLS.has(name)));
    event.systemPromptOptions.sections.confined_tools = "File tools, Bash, Notes, Graphify, Git inspection, LSP, local MCP servers, CI queries and web helpers execute inside Codex's OS sandbox. Writes: current workspace and private TMPDIR; outside reads allowed. The fixed Notes worker can also write project note storage, its Git exclude entry and the central notes.db with SQLite sidecars. Only in the interactive parent, after a failed foreground Bash call, request_command_access may request exact additional write paths and/or Metal GPU access when a reviewed backend has passed native qualification: the approval broker must approve the stored command/cwd/capabilities before one supervised rerun inside Codex. Inspect partial effects first; no automatic retry. These grants never persist or reach subagents. Ordinary Bash has no GPU access even after installation or restart; a nil Metal device there does not test the optional backend. Preserve the real exit status (set -o pipefail for pipelines; probes must exit nonzero on a missing device), keep the command in the foreground with timeoutAction=kill, then request_command_access with gpu=metal and the captured failed_call_id. Report the approved rerun result; do not infer missing backend permissions from an ordinary Bash result. Before new authorized edits, use jj_checkpoint to initialize missing jj/Git and save a local recovery point; record its full operation and commit IDs. Initialization needs one approval, later snapshots have separate revocable session/project consent. No automatic restoration; ignored files and external state are excluded. For authorized Git writes, use git_access directly: new branch, explicit-file staging and commit can share once/session/project consent; push always needs a separate exact approval. Its fixed worker and hooks remain jailed. On Linux the parent publishes only validated, operation-specific metadata from a disposable Git copy under native locks; real Git config, hooks and general Bash access remain protected. A stored permission does not itself request a commit or push. /git-access permissions revokes repository consent. Never use Dunst as a Git workaround. Network is restricted to approved public hosts; request_network_access never disables filesystem confinement. Subagents inherit active confined tools without recursion or cwd widening; their model transport and private session artifacts remain host-side. Dunst remains denied by the local strict dispatcher, including in the interactive parent. MCP only accepts trusted local stdio definitions, not remote URLs; declared read-only tools may have once/session/project consent, while unknown or mutating operations require fresh exact approval. MCP annotations are unverified; remembered grants do not authorize sending messages or submitting forms without the user's explicit go for that exact action. request_host_access is a separate parent-only, individually approved host capability for bounded Podman, clipboard and process operations, never a generic shell or a remembered grant. Refusal stays refusal; /host-access reset clears pending approvals/refusals. Clipboard transfer does not authorize login or form submission. request_build_access is a separate parent-only, one-shot Linux image build: inspect ansible/build.yml, packer/, config/ and ansible.cfg first. Human consent allows /dev/kvm and FULL native host networking including local services and Unix sockets, with writes limited by Bubblewrap to .cache/, output/ and private temp. The exact command is ansible-playbook -i localhost, ansible/build.yml, supervised for at most 240 minutes. Ordinary Bash retains its policy. A missing /dev/kvm in ordinary Bash is not proof that host KVM is absent; use the dedicated capability for an authorized build instead of asking for generic write_paths. Keep the task pending until the build completes and validate artifacts. /build-access reset cancels the build and clears refusals. Missing capabilities call for a precise incident and a tested, reviewable source patch; never edit the active harness or approve its own expansion. model_catalog reads the existing registry snapshot without starting Pi or resolving credentials; cached availability is not quota/auth validation. task_checkpoint is parent-only session metadata: it records requirements and evidence without command execution or granting permissions. The user can configure /approvals auto <scope> or auto-deny <scope> for this project: eligible confirmations then use a separate reviewer; auto-deny refuses uncertainty without a dialog. Use the capability tools normally; do not ask a redundant textual confirmation first. The main agent cannot approve itself, change this policy, or treat earlier automatic decisions as user consent. Manual is the default. Other tools without executors are denied. Never retry a sandbox denial through an unrestricted tool; request only an explicitly supported capability and continue independent authorized work.";
  });
  pi.registerCommand("confined-tools", {
    description: "Show confined executors, one-command write approvals and blocked host automation",
    handler: async (_args, ctx) => {
      try { verify(ctx); ctx.ui.notify(`Strict sandbox configured: ${[...CONFINED_TOOLS].join(", ")}. Other tools denied except request_command_access, request_host_access, request_build_access, request_podman_access, git_access, jj_checkpoint, task_checkpoint session metadata and the read-only model_catalog snapshot. git_access offers repository-scoped local Git consent, but each push needs its own approval; /git-access permissions revokes it. Additional filesystem paths or an installed, qualified Metal capability require approval of one exact failed command retry; additional public network hosts require approval. Metal is never enabled for ordinary Bash by installation or restart: use request_command_access with gpu=metal after a foreground failure. A nil device in ordinary Bash is expected. Dunst is host-side and remains denied in this jail. /dunst permissions and /mcp permissions revoke project consent. KVM image builds use request_build_access with explicit one-shot approval; /build-access reset cancels them. Restart required after installation.`, "info"); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
