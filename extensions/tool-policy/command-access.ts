import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { reviewApproval } from "../../lib/approval-review.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";
import { metalBackend } from "../../scripts/metal-backend.mjs";

interface FailedCommand { command: string; cwd: string; expires: number }

export function registerCommandAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  let root: string | undefined;
  let tasks = new SessionTasks();
  let tail: Promise<unknown> = Promise.resolve();
  const running = new Map<string, FailedCommand>();
  const failed = new Map<string, FailedCommand>();
  const reset = (ctx?: ExtensionContext) => {
    root = ctx ? realpathSync(ctx.cwd) : undefined;
    running.clear(); failed.clear();
    const previous = tasks;
    tasks = new SessionTasks();
    return previous.close();
  };
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_before_switch", () => reset());
  pi.on("session_before_fork", () => reset());
  pi.on("session_before_tree", () => reset());
  pi.on("session_shutdown", () => reset());
  // Tree navigation (or canceled navigation) does not emit session_start.
  pi.on("before_agent_start", (_event, ctx) => {
    if (!root) { verify(ctx); root = realpathSync(ctx.cwd); }
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || event.parentToolCallId || ("background" in event.input && event.input.background) || !ctx.hasUI || !pi.getActiveTools().includes("request_command_access")) return;
    const command = event.input.command;
    if (!root || root !== realpathSync(ctx.cwd) || typeof command !== "string" || command.length > 2000 || running.size >= 16) return;
    verify(ctx);
    running.set(event.toolCallId, { command, cwd: root, expires: Date.now() + 300_000 });
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash") return;
    const request = running.get(event.toolCallId);
    running.delete(event.toolCallId);
    if (!request || !event.isError || request.command !== event.input.command || root !== request.cwd || realpathSync(ctx.cwd) !== root) return;
    if (failed.size >= 16) failed.delete(failed.keys().next().value!);
    failed.set(event.toolCallId, { ...request, expires: Date.now() + 300_000 });
    return {
      content: [...event.content, { type: "text" as const, text: `If this failure needs additional filesystem writes or Metal access, use request_command_access with failed_call_id=${JSON.stringify(event.toolCallId)}, only the necessary write_paths and/or gpu="metal", and a reason. Metal requires an operator-installed qualified backend. Approval reruns this entire command once; earlier side effects may repeat. No automatic retry.` }],
      structuredContent: event.structuredContent,
    };
  });

  pi.registerTool({
    name: "request_command_access", label: "Request one-command access",
    description: "After a failed foreground Bash call, request approval to rerun that exact command once with additional filesystem write paths and/or Metal GPU access. Metal requires a separately reviewed, installed and natively qualified backend; it never grants file or network access. The stored command and cwd cannot be replaced. Runtime/configuration paths (including Pi locks) and workspace ancestors cannot be granted. Codex confinement and existing network policy remain active. Directories grant their subtree. No background, headless, delegated, permanent or unsandboxed execution. Requests expire after five minutes and are consumed once, including refusal. Execution is limited to 60 seconds and the command tree is canceled on session changes.",
    promptGuidelines: [
      "KVM is not a filesystem write grant. For an authorized Packer/Ansible image build needing /dev/kvm, use request_build_access after inspecting the project sources; do not request /dev or /dev/kvm in write_paths.",
      "Only request the write paths or Metal capability necessary for the reported failure. Inspect partial effects before proposing a retry. Never use another executor to bypass a sandbox denial.",
      "Ordinary Bash has no Metal access, even after installation or restart. A nil Metal device there does not test the optional backend. After an eligible failure, use this tool with gpu=metal and the captured failed_call_id; report the approved rerun result.",
      "Keep the GPU command in native foreground bash with an explicit timeout. Preserve its real failure status: use set -o pipefail for pipelines, do not append echo or otherwise swallow an error, and make a Metal probe exit nonzero when no device is available. A successful shell result cannot request access. Never manufacture an unrelated failure to obtain a grant.",
    ],
    parameters: Type.Object({
      failed_call_id: Type.String({ minLength: 1, maxLength: 256 }),
      write_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 8 })),
      gpu: Type.Optional(Type.Literal("metal")),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    executionMode: "sequential",
    async execute(_id, input, signal, _update, ctx) {
      const audit = new PermissionAudit(agentDir, { ...ctx, cwd: root ?? ctx.cwd }, {
        resource: "command-access", operation: input.gpu === "metal" ? "retry-metal" : "retry",
        toolCallId: _id, payload: input, targets: input.write_paths,
      });
      try {
        // Snapshot before queuing or awaiting human input; no mutable arguments survive approval.
        const id = input.failed_call_id, reason = input.reason, paths = [...(input.write_paths ?? [])], gpu = input.gpu;
        if ((!paths.length && !gpu) || (gpu !== undefined && gpu !== "metal")) throw new Error("Request exact write paths and/or gpu=metal");
        const request = failed.get(id);
        if (!request) throw new Error("No eligible failed Bash call in this session; no retry");
        failed.delete(id);
        return await tasks.run(async owned => {
          const run = async () => {
            const validate = () => {
              owned.throwIfAborted();
              verify(ctx);
              if (root !== request.cwd || realpathSync(ctx.cwd) !== request.cwd || Date.now() > request.expires) throw new Error("Command approval is stale, expired or belongs to another workspace");
              if (!ctx.hasUI || !pi.getActiveTools().includes("request_command_access")) {
                audit.finish("denied", "unavailable");
                throw new Error("Command access requires interactive parent confirmation or automatic review");
              }
              return paths.length ? commandWritableRoots(paths, request.cwd, agentDir, [getPackageDir()]) : [];
            };
            const roots = validate();
            const backend = gpu ? metalBackend(agentDir) : undefined;
            const display = JSON.stringify({ command: request.command, cwd: request.cwd, additional_write_paths: roots, gpu, backend_sha256: backend?.sha256, reason }, null, 2)
              .replace(/[\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
            const review = await reviewApproval(agentDir, ctx, { resource: "command-access", operation: gpu ? "retry-metal" : "retry", detail: display }, audit, owned);
            let abort = () => {};
            const canceled = new Promise<false>(resolve => {
              abort = () => resolve(false);
              owned.addEventListener("abort", abort, { once: true });
              if (owned.aborted) abort();
            });
            let approved: boolean;
            try {
              if (review.decision === "allow") approved = true;
              else {
                audit.prompted();
                approved = await Promise.race([
                  ctx.ui.confirm("Retry once with additional command access?", `The ENTIRE failed command will run again; earlier effects may repeat. Directories include their contents, but Codex may still forbid deleting or renaming the granted directory itself. ${gpu ? "Metal grants the command tree access to the GPU driver and shader compiler. " : ""}Workspace/temp permissions and network policy stay unchanged. No permanent grant, no execution outside Codex. Deadline: 60 seconds.\n${display}`, { signal: owned, timeout: Math.max(1, request.expires - Date.now()) }),
                  canceled,
                ]);
                audit.answered(owned.aborted ? "cancel" : approved ? "allow" : "deny");
              }
            } finally { owned.removeEventListener("abort", abort); }
            review.check();
            validate();
            if (!approved) throw new Error("Command access refused; nothing executed");
            if (backend && metalBackend(agentDir).sha256 !== backend.sha256) throw new Error("Metal backend changed during approval; nothing executed");
            const output: Buffer[] = [];
            const journal = (status: string, error?: string) => {
              if (backend) pi.appendEntry("metal_command", { status, at: new Date().toISOString(), failedCallId: id, command: request.command, cwd: request.cwd, writePaths: roots, backendSha256: backend.sha256, timeoutMs: 60_000, output: Buffer.concat(output).toString("utf8").slice(-6000), error });
            };
            // A missing result journal must prevent execution, not silently drop the audit trail.
            audit.finish("granted", review.decision === "allow" ? "policy" : "human", "once");
            journal("started");
            try {
              await execute(join(runtimeRoot, "scripts/codex-shell.mjs"), [...(backend ? ["--metal", backend.sha256] : []), ...(roots.length ? ["--write-roots", JSON.stringify(roots)] : []), "-c", request.command], {
                cwd: request.cwd, signal: owned, timeoutMs: 60_000, maxBytes: 1024 * 1024,
                env: { PI_CODING_AGENT_DIR: agentDir },
                onStdout: chunk => output.push(chunk), onStderr: chunk => output.push(chunk),
              });
            } catch (error) {
              journal(owned.aborted ? "canceled" : "failed", (error as Error).message);
              throw new Error(`${(error as Error).message}\n${Buffer.concat(output).toString("utf8").slice(-6000)}\nOne-shot access consumed; no automatic retry.`);
            }
            const text = Buffer.concat(output).toString("utf8");
            journal("completed");
            return { content: [{ type: "text" as const, text: `${text.length > 60000 ? "[Output truncated to last 60000 characters]\n" : ""}${text.slice(-60000)}\nOne-shot access consumed; subsequent commands retain their original permissions.` }], details: { failedCallId: id, writePaths: roots, ...(backend ? { gpu, backendSha256: backend.sha256 } : {}) } };
          };
          const result = tail.then(run, run);
          tail = result.catch(() => undefined);
          return result;
        }, signal);
      } catch (error) { audit.fail(signal); throw error; }
    },
  });
}
