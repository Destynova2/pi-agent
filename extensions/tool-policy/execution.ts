import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExecutionError, executionCapabilities, prepareExecution, type ExecutionRequest } from "../../lib/execution-plan.ts";
import { reviewApproval } from "../../lib/approval-review.ts";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { runProcess } from "../../lib/process.ts";

type Job = { id: string; session: string; cwd: string; state: "running" | "completed" | "failed" | "stopped"; output: string; error?: string; controller: AbortController; done: Promise<void> };
const response = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

export function registerExecution(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void,
  dependencies = { prepare: prepareExecution, execute: runProcess }) {
  let tasks = new SessionTasks(), jobs = new Map<string, Job>(), reservations = new Map<string, string[]>(), generation = 0;
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, async () => {
    generation++;
    const previous = tasks; tasks = new SessionTasks(); jobs = new Map(); reservations = new Map();
    await previous.close();
  });
  const snapshot = (job: Job) => ({ id: job.id, state: job.state, output: job.output, ...(job.error ? { error: job.error } : {}), health: "not assessed", lifetime: "session" });
  pi.registerTool({
    name: "execution", label: "Confined execution", executionMode: "sequential",
    description: "Inspect capabilities; run an exact command with combined scoped writes and public hosts, or private offline input copies; inspect/stop owned session jobs. Fresh tool-free task review, no dialog, remembered grant or failed Bash prerequisite. Explicit policy wins. Unsupported resources fail closed. No persistent service, device, host socket or Git metadata grant.",
    promptGuidelines: ["Query capabilities before requesting resources. Workspace profile uses live files and baseline host reads; hosts defaults to offline. Isolated uses explicit input copies, private Unix IPC and disposable writes, without network. Background jobs expire within their reviewed deadline and end on session change; inspect completion before claiming success. Use git_access for protected Git writes. Inspect partial effects before a retry; no broader executor after a review refusal."],
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("capabilities") }, { additionalProperties: false }),
      Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("stop")]), job_id: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("run"), command: Type.String({ minLength: 1, maxLength: 8000 }), reason: Type.String({ minLength: 1, maxLength: 1000 }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })), profile: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("isolated")])),
        write_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 8 })), hosts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 10 })),
        inputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 16 })), binaries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })), background: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    ]),
    async execute(id, input, signal, _update, ctx) {
      verify(ctx);
      if (process.env.PI_SUBAGENT_CHILD || !pi.getActiveTools().includes("execution")) throw new ExecutionError("policy_denied", "Execution is available only in its active parent session");
      if (input.action === "capabilities") return response(executionCapabilities());
      const session = ctx.sessionManager.getSessionId(), cwd = realpathSync(ctx.cwd);
      if (input.action === "status" || input.action === "stop") {
        const job = jobs.get(input.job_id);
        if (!job || job.session !== session || job.cwd !== cwd) throw new ExecutionError("policy_denied", "Unknown job for this session");
        if (input.action === "stop" && job.state === "running") { job.controller.abort(); await job.done; }
        return response(snapshot(job));
      }
      if (input.action !== "run") throw new ExecutionError("invalid_request", "Unknown execution action");
      const { action: _action, ...request } = structuredClone(input);
      const audit = new PermissionAudit(agentDir, ctx, { resource: "execution", operation: "run", toolCallId: id, payload: request });
      const epoch = generation, ownedTasks = tasks, ownedJobs = jobs, ownedReservations = reservations;
      const validate = () => {
        signal?.throwIfAborted(); verify(ctx);
        if (generation !== epoch || ctx.sessionManager.getSessionId() !== session || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("execution")) throw new ExecutionError("stale_request", "Session or execution capability changed");
      };
      let released: (() => void) | undefined;
      // The outer task covers preparation/review. A background worker also registers
      // its complete lifetime before this task returns, so session close joins both.
      try {
        return await ownedTasks.run(async owned => {
          validate(); owned.throwIfAborted();
          if (ownedReservations.size >= 4) throw new ExecutionError("resource_limit", "At most four active execution jobs");
          const plan = dependencies.prepare(request as ExecutionRequest, cwd, agentDir);
          released = plan.dispose;
          const scope = plan.summary as { profile: string; cwd: string; writePaths?: string[] };
          const roots = scope.profile === "workspace" ? [scope.cwd, ...(scope.writePaths ?? [])] : [];
          const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
          if (roots.some((root, i) => roots.slice(i + 1).some(other => overlaps(root, other))) ||
              [...ownedReservations.values()].some(existing => roots.some(root => existing.some(other => overlaps(root, other))))) throw new ExecutionError("resource_conflict", "A writable root is already owned by this plan or another pending/running request");
          const reservation = randomUUID(); ownedReservations.set(reservation, roots);
          let disposed = false;
          const cleanup = () => { if (disposed) return; disposed = true; ownedReservations.delete(reservation); plan.dispose(); };
          released = cleanup;
          const review = await reviewApproval(agentDir, ctx, { resource: "execution", operation: "run", detail: JSON.stringify(plan.summary) }, audit, owned, "task");
          review.check(); validate(); owned.throwIfAborted(); plan.validate();
          if (review.decision !== "allow") { audit.finish("denied", "policy", "once"); throw new ExecutionError("policy_denied", "Explicit manual policy disables automatic execution"); }
          const launch = plan.launch();
          audit.finish("granted", "policy", "once");
          const controller = new AbortController();
          const job: Job = { id: randomUUID(), session, cwd, state: "running", output: "", controller, done: Promise.resolve() };
          if (request.background) {
            if (ownedJobs.size >= 32) {
              const old = [...ownedJobs.values()].find(job => job.state !== "running");
              if (old) ownedJobs.delete(old.id);
            }
            ownedJobs.set(job.id, job);
          }
          const dispose = cleanup; released = undefined;
          const work = async (jobSignal: AbortSignal) => {
            const collect = (chunk: Buffer) => { job.output = (job.output + chunk.toString("utf8")).slice(-60000); };
            try {
              audit.event("execution.started", { jobId: job.id, profile: request.profile ?? "workspace", background: request.background ?? false, timeoutMs: launch.options.timeoutMs });
              await dependencies.execute(launch.program, launch.args, { ...launch.options, signal: jobSignal, maxBytes: 1024 * 1024, onStdout: collect, onStderr: collect });
              job.state = jobSignal.aborted ? "stopped" : "completed";
            } catch (error) {
              job.state = jobSignal.aborted ? "stopped" : "failed";
              job.error = `${(error as Error).message} No automatic retry; inspect partial effects.`;
            } finally {
              try { dispose?.(); } catch (error) { job.state = "failed"; job.error = `Cleanup failed: ${(error as Error).message}`; }
              try { audit.event("execution.finished", { jobId: job.id, state: job.state }); }
              catch { job.state = "failed"; job.error = "Execution finished but its audit record failed; inspect effects before retrying"; }
            }
          };
          if (!request.background) {
            await work(owned);
            if (job.state !== "completed") throw new ExecutionError(job.state === "stopped" ? "canceled" : "execution_failed", `${job.error ?? "Operation canceled"}\n${job.output}`);
            return response({ ...snapshot(job), lifetime: "foreground" });
          }
          job.done = ownedTasks.run(work, controller.signal).catch(error => { job.state = "failed"; job.error = (error as Error).message; }).finally(cleanup).then(() => {
            if (generation === epoch) pi.sendMessage({ customType: "execution_completion", content: JSON.stringify({ id: job.id, state: job.state }), display: true }, { triggerTurn: true });
          }).catch(error => { job.error = `Completion notification failed: ${(error as Error).message}`; });
          return response(snapshot(job));
        }, signal);
      } catch (error) { audit.fail(signal, error); throw error; }
      finally { released?.(); }
    },
  });
}
