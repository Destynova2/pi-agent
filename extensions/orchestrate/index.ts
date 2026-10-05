import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { join } from "node:path";
import { recommendedWorkspace, workspaceHint } from "./workspace.ts";

const TASK_COMPLETION_PROMPT = `Own the full authorized request, not just its first slice. Minimal code does not mean reduced scope, even in Ponytail mode. Respect the requested deliverable: a plan-only or read-only audit request does not authorize implementation.
For multi-part work, identify every requested outcome (including annotations), dependencies and acceptance checks before editing. Use task_checkpoint when available for requirement coverage and existing notes for shared evidence. A plan, checkpoint, worker report or passing slice test is not completion of an implementation request.
An in-task strategy request does not cancel remaining work; honor explicit pauses. Continue authorized, unblocked work after each slice and review; do not ask whether to continue steps already requested. The parent owns integration and verification of the combined result; a child's done status is not proof. A child completes its assigned task and write-set, not the parent's entire scope.
When blocked, use an available approval mechanism or ask for the exact missing decision or permission, then continue independent authorized work. Never bypass a denial, retry indefinitely, silently drop requirements, or invent approval. Optional delegation being unavailable is not a reason to stop work you can perform directly; required human or review gates remain blocking.
After a resolved blocker, approval or restart, verify the fix and resume the remaining authorized work in the same turn unless the user explicitly pauses or limits the scope. A narrow verification question does not silently cancel the larger request. Recheck a previously unavailable approval route when its prerequisite changes; do not repeat an unchanged denial. Track source integration, runtime installation, activation and application acceptance separately; a scratch patch or restart is not proof of all four. If a mandatory gate still blocks progress, name its exact next action, not a vague promise to handle it separately.
Before the final answer, reconcile the original request with the current files and actual results. For each outstanding outcome, state what is missing and its blocker; distinguish implemented, verified and awaiting human validation. Report partial work as partial. Finish only when the requested deliverable is verified or the remaining work is genuinely blocked or explicitly deferred by the user. No unrequested commit, push or deployment.`;

/**
 * Prefix for `/orchestrate <request>`. The current agent acts as the chef:
 * it adapts effort to complexity and risk, delegates only when useful,
 * and requests independent review for risky changes.
 */
const ORCHESTRATE_PROMPT = `Own the request; never invent progress. These are instructions, not a workflow engine or a global session tracker.

Read the relevant code, repository rules and context before editing. If intent remains materially ambiguous, ask the user directly before acting. For audits, stay read-only and cite file:line findings.

Adapt effort to complexity and risk, not file count. Handle a simple, low-risk task directly without a formal planning template or mandatory delegation. For complex/risky work, note scope, owners and checks. Batch independent investigations and read-only checks; serialize shared writes. Scouts return source-backed findings and questions; don't repeat their scans. Request an independent reviewer for risky changes, preferably from another model family, and provide the full diff, scope, ownership and test evidence.

Deliver a first usable, tested slice before broad write delegation. Fix contracts before parallel work; use chain for dependencies. Set timeoutSeconds; on expiry inspect partial work, never retry automatically. Integrate the first return directly, without a second correction round by default. The first slice is a checkpoint, not the finish line. Give each worker the goal, paths, constraints and acceptance check; children do not inherit this conversation. After each slice, save a checkpoint in shared notes: done, files, check + exit code, blockers, next step, child resume IDs. After compaction, resume the checkpoint rather than restart completed exploration. Before resuming, inspect the current worktree; notes are hints, not proof. Before completion, verify the combined change and map each requirement to evidence; unverified items stay open.

Use configured agent models; verify availability before delegating and choose the least costly suitable available model. If optional delegation is unavailable, work directly. If required review is unavailable, ask about that gate and keep it open; continue independent authorized work. Never present solo work as independently reviewed. After review findings, fix and re-review; stop and report on a repeated rejection, escalation or lack of progress.

Before edits, check other agents' claims and protect preexisting changes. Sequence overlapping work; agree scope before expanding. Ask before unapproved dependency, CI, test-removal, secret-handling or functional scope changes. Never overwrite others' work or restore the whole worktree. A git/jj reference in a note is not a backup.

Verify with real checks: wait for completion, preserve exit codes, and report failures or skipped checks. Never hide failures behind output-filtering pipelines. No commit, push, merge or deployment without explicit user authorization; a review verdict does not authorize deployment. After a PR push, use ci_watch if available; report pending CI as pending or unwatched. Attribute any approval to the actual reviewer.

Report changes, checks, blockers and agents used.

Request:
`;

const AUTO_DELEGATION_PROMPT = `Adapt the work to the user's request automatically; /orchestrate is optional. Start direct for simple or tightly coupled work, without a planner agent or an extra model call just to choose a workflow.
Deliver a first usable, tested slice before broad write delegation, then continue the remaining authorized requirements. Split progressively only after contracts are stable and a subtask has a clear goal, boundary and acceptance check. Use parallel only for independent tasks; use chain with {previous} for dependencies. Set timeoutSeconds explicitly; expiry stops the child, so inspect partial reports and the current diff rather than retry automatically. Integrate the first return directly; no second correction round by default. Report scope growth or lack of a usable result before another long delegation. Batch independent investigations, read-only checks and disjoint write-sets; keep shared-file or strongly coupled changes together/sequential. While children work, handle a different useful slice, not their same investigation. Consolidate when coordination costs exceed the benefit. Do not use file-count thresholds or a fixed number of agents.
Give each child the objective, relevant paths, constraints and acceptance check. Check its available capabilities: headless children cannot approve ask-policy tools. Resume an owned child for a follow-up on the same task instead of making it rediscover everything; do not reuse unrelated history. Do not bypass permissions or invent independent review.
Stop exploring when the next scoped change and its acceptance check are clear. Scouts return findings with source ranges and open questions; verify disputed/high-risk findings without repeating their whole scans. After compaction, resume from the latest checkpoint, remaining requirements and current diff; re-read only changed or missing evidence. Keep original-request/artifact pointers and child resume IDs in checkpoints. Verify the combined result against the original request. Explain the chosen split briefly only when delegation helps; no ceremony for trivial work. Ask before material ambiguity or an unapproved scope change. No commit, push or deployment without explicit user authorization.`;

const JJ_WORKFLOW_PROMPT = `For repository work, prefer jj when available and initialized unless the user/project requires Git. Check once per repository/session: executable (command -v jj, jj --version), Git root, existing jj workspace. A missing .jj directory does not mean jj needs installing. Check parent roots from subdirectories.
Before each new authorized modification task, use jj_checkpoint when available. It initializes jj/Git only if missing and snapshots preexisting changes before edits; save its full operationId and commitId, plus gitRef, with the task. Reuse that checkpoint during continuation, taking another before a separately requested risky phase. Never reinitialize existing jj. Initialization alone is not a recovery point. Ignored files and external state are excluded; a failed checkpoint is not proof of recoverability. Restoration requires a separate explicit user request.
Prepare jj without asking whether to proceed with routine checks. If absent, identify the platform/package manager, propose the exact install command and obtain the required installation/capability approval; never bootstrap a package manager or run curl | sh. Verify jj --version after installation.
Inspect the root and preexisting status. Run jj git init --colocate only through a capability explicitly permitting the metadata writes. Do not initialize during read-only audits, in bare repositories, linked worktrees, submodules, or an existing jj workspace. If no supported capability exists, report the exact host command once; do not attempt a known-forbidden .git write. Never widen sandbox permissions, change Git configuration or use a host workaround. Verify jj root and jj status after initialization within available permissions; do not overwrite preexisting changes.
Even jj status may snapshot: use --ignore-working-copy for read-only inspection. A jj preference authorizes no Git commit, push, child conversion, or bypass of git_access. Children reuse the parent's preparation and report missing prerequisites. If a checkpoint is blocked, continue read-only work and report the blocker before edits requiring recovery coverage. Gate policy configuration remains a separate prerequisite: initialization does not enable gates.`;

/** Adaptive instructions for ordinary turns, plus explicit orchestration/gate commands. */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
    sections.task_completion = TASK_COMPLETION_PROMPT;
    sections.jj_workflow = JJ_WORKFLOW_PROMPT;
    if (process.env.PI_SUBAGENT_CHILD || !pi.getActiveTools().includes("subagent") || event.prompt.startsWith(ORCHESTRATE_PROMPT)) {
      delete sections.adaptive_delegation;
      return;
    }
    sections.adaptive_delegation = AUTO_DELEGATION_PROMPT;
  });
  let active: AbortController | undefined;
  let task: Promise<string> | undefined;
  const stop = async () => {
    active?.abort();
    await task?.catch(() => undefined);
  };
  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    if (!ctx?.hasUI) return;
    const workspace = await recommendedWorkspace(ctx.cwd);
    if (workspace) ctx.ui.notify(workspaceHint(workspace), "info");
  });
  pi.registerCommand("orchestrate", {
    description: "Orchestrate a request: /orchestrate <request>. Also: gates [quick|full|dry-run], status, cancel.",
    handler: async (args, ctx) => {
      const request = args.trim();
      const [action, mode = "full", ...extra] = request.split(/\s+/);
      if (!request) {
        ctx.ui.notify("Write /orchestrate followed by your request.", "info");
        return;
      }
      if (request === "cancel") {
        active?.abort();
        ctx.ui.notify(active ? "Canceling gates and their running processes…" : "No gate in progress.", "info");
        return;
      }
      if (request === "status") {
        ctx.ui.notify(`${active ? "Local gates in progress." : "No local gate in progress."} Local gates status only: no global orchestration is tracked. Previous reviews do not count as approval of this version. Push and merge not enabled.`, "info");
        return;
      }
      if (action !== "gates") {
        pi.sendUserMessage(ORCHESTRATE_PROMPT + request, { deliverAs: "followUp" });
        return;
      }
      if (!["quick", "full", "dry-run"].includes(mode) || extra.length) {
        ctx.ui.notify("Usage: /orchestrate gates [quick|full|dry-run] | status | cancel. A gates policy must be configured for the jj root.", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("Gates are already in progress in this session.", "warning");
        return;
      }
      active = new AbortController();
      ctx.ui.setStatus("orchestrate", `Gates ${mode} on clean copy…`);
      try {
        const signals = ctx.signal ? [active.signal, ctx.signal] : [active.signal];
        // Official binary copied into the agent dir; PI_GATES_BIN remains an escape hatch (tests, alternative install).
        const gatesBin = process.env.PI_GATES_BIN || join(getAgentDir(), "gates/pi-prek");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        task = runProcess(join(getAgentDir(), "scripts/codex-shell.mjs"), ["-c", `${quote(gatesBin)} ${quote(mode)}`], {
          cwd: ctx.cwd, signal: AbortSignal.any(signals), timeoutMs: 2 * 60 * 60 * 1000,
          maxBytes: 8 * 1024 * 1024,
        });
        const output = await task;
        ctx.ui.notify(output.slice(-10000), "info");
      } catch (error) {
        ctx.ui.notify(`Gates BLOCKED: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        active = undefined;
        task = undefined;
        ctx.ui.setStatus("orchestrate", undefined);
      }
    },
  });
}
