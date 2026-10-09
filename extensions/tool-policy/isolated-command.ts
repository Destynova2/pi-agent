import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshotCommand, isolatedArgs, isolatedRuntime } from "../../lib/isolated-command.ts";
import { privateIpcSeccomp } from "../../lib/private-ipc-seccomp.mjs";
import { reviewApproval } from "../../lib/approval-review.ts";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

export function registerIsolatedCommand(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess, prepareRuntime = isolatedRuntime) {
  let tasks = new SessionTasks();
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, () => {
    const previous = tasks; tasks = new SessionTasks(); return previous.close();
  });
  pi.registerTool({
    name: "run_isolated", label: "Run an isolated offline command",
    description: "Execute once in a disposable Linux filesystem with private Unix sockets, no external network, host sockets, original-file writes or inherited secrets. Copies at most 512 MiB of explicit project inputs (excluding metadata, credential/state filenames); rejects symlinks and special files. Optional installed standalone ELF binaries are copied into PATH. OS tools come from protected /usr runtime trees. Sources and binaries are snapshotted before a tool-free LLM reviews the exact command. No human dialog, persistent grants, host fallback or automatic retry. Output is returned; files are discarded. Maximum duration 120 seconds.",
    promptGuidelines: [
      "Use for offline provider schema validation and tests needing private IPC. No failed Bash call is required. This cannot contact Nexus or run a live plan/apply. Do not use the KVM build capability for provider IPC.",
      "For OpenTofu, first prepare providers in a project-local directory using init -backend=false -lockfile=readonly, with scoped network access if needed. Then copy that directory plus the configuration here, set TF_DATA_DIR to its copied /work path, and run validate. Import the installed tofu ELF binary when it is outside /usr/bin. Do not copy live state or credentials. A cached provider symlink must be materialized as an ordinary file in the prepared input directory.",
      "Commands run in /work. Inputs keep their project-relative paths. Never assume missing dependencies or an outer sandbox refusal are a successful validation; return the exact error without selecting an unrestricted executor.",
    ],
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 8000 }), inputs: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 16 }),
      binaries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4 })), reason: Type.String({ minLength: 1, maxLength: 1000 }) }),
    executionMode: "sequential",
    async execute(id, input, signal, _update, ctx) {
      const request = structuredClone(input), cwd = realpathSync(ctx.cwd);
      const audit = new PermissionAudit(agentDir, ctx, { resource: "isolated-command", operation: "run", toolCallId: id, payload: request, targets: request.inputs });
      try {
        return await tasks.run(async owned => {
          const validate = () => { owned.throwIfAborted(); verify(ctx); if (process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("run_isolated")) throw new Error("Isolated command is stale or unavailable in this parent session"); };
          validate();
          const filter = privateIpcSeccomp();
          const runtime = prepareRuntime();
          const snapshot = snapshotCommand(cwd, agentDir, request.inputs, request.binaries);
          try {
            const args = isolatedArgs(snapshot, request.command, runtime);
            const review = await reviewApproval(agentDir, ctx, { resource: "isolated-command", operation: "run", detail: JSON.stringify({ ...request, cwd, snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes, inputs: snapshot.inputs, binaries: snapshot.binaries }, capabilities: "private offline snapshot; no host writes, services, secrets or external network; output only", timeoutMs: 120_000 }) }, audit, owned, "task");
            review.check(); validate();
            if (review.decision !== "allow") { audit.finish("denied", "policy", "once"); throw new Error("Automatic review disabled by manual policy; no isolated command executed"); }
            audit.finish("granted", "policy", "once");
            const output: Buffer[] = [];
            try {
              await execute(runtime.backend, args, { cwd: snapshot.directory, signal: owned, input: Readable.from([filter]), timeoutMs: 120_000, maxBytes: 1024 * 1024, onStdout: chunk => output.push(chunk), onStderr: chunk => output.push(chunk) });
            } catch (error) { throw new Error(`${(error as Error).message}\n${Buffer.concat(output).toString("utf8").slice(-6000)}\nPrivate job failed; no host fallback or automatic retry.`); }
            return { content: [{ type: "text" as const, text: `${Buffer.concat(output).toString("utf8").slice(-60000)}\nPrivate job completed. Original files unchanged; disposable files discarded.` }], details: { sha256: snapshot.sha256, network: "none", privateIPC: true } };
          } finally { snapshot.dispose(); }
        }, signal);
      } catch (error) { audit.fail(signal, error); throw error; }
    },
  });
}
