import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { join } from "node:path";
import { recommendedWorkspace, workspaceHint } from "./workspace.ts";

/**
 * Prefix for `/orchestrate <request>`. The current agent acts as the chef:
 * it adapts effort to complexity and risk, delegates only when useful,
 * and requests independent review for risky changes.
 */
const ORCHESTRATE_PROMPT = `Own the request. Never invent progress. These are reasoning instructions, not a workflow engine or a global session tracker.

Read the relevant code, repository rules and context before editing. If intent remains materially ambiguous, ask the user directly before acting. For audits, stay read-only and cite file:line findings.

Adapt effort to complexity and risk, not file count. Handle a simple, low-risk task directly without a formal planning template or mandatory delegation. For complex/risky work, note scope, owners and checks. Batch independent investigations and read-only checks; serialize shared writes. Scouts return source-backed findings and questions; don't repeat their scans. Request an independent reviewer for risky changes, preferably from another model family, and provide the full diff, scope, ownership and test evidence.

Deliver a first usable, tested slice before broad write delegation. Fix contracts before parallel work; use chain for dependencies. Set timeoutSeconds; on expiry inspect partial work, never retry automatically. Integrate the first return directly, without a second correction round by default. Preserve remaining requirements. Give each worker the goal, paths, constraints and acceptance check; children do not inherit this conversation. After each slice, save a checkpoint in shared notes: done, files, check + exit code, blockers, next step, child resume IDs. After compaction, resume the checkpoint rather than restart completed exploration. Before resuming, inspect the current worktree; notes are hints, not proof. Before completion, verify the combined change and map each requirement to evidence; unverified items stay open.

Use configured agent models; verify availability before delegating and choose the least costly suitable available model. If delegation or independent review is needed but unavailable, explain the limitation and ask whether to continue solo; wait for the user's answer. Never present solo work as independently reviewed. After review findings, fix and re-review; stop and report on a repeated rejection, escalation or lack of progress.

Before edits, check other agents' claims and protect preexisting changes. Sequence overlapping work; agree scope before expanding. Ask before unapproved dependency, CI, test-removal, secret-handling or functional scope changes. Never overwrite others' work or restore the whole worktree. A git/jj reference in a note is not a backup.

Verify with real checks: wait for completion, preserve exit codes, and report failures or skipped checks. Never hide failures behind output-filtering pipelines. No commit, push, merge or deployment without explicit user authorization; a review verdict does not authorize deployment. After a PR push, use ci_watch if available; report pending CI as pending or unwatched. Attribute any approval to the actual reviewer.

Finish briefly: changes, checks, blockers and agents used. Do not claim completion before verification.

Request:
`;

const AUTO_DELEGATION_PROMPT = `Adapt the work to the user's request automatically; /orchestrate is optional. Start direct for simple or tightly coupled work, without a planner agent or an extra model call just to choose a workflow.
Deliver a first usable, tested slice before broad write delegation. Split progressively only after contracts are stable and a subtask has a clear goal, boundary and acceptance check. Use parallel only for independent tasks; use chain with {previous} for dependencies. Set timeoutSeconds explicitly; expiry stops the child, so inspect partial reports and the current diff rather than retry automatically. Integrate the first return directly; no second correction round by default. Report scope growth or lack of a usable result before another long delegation. Batch independent investigations, read-only checks and disjoint write-sets; keep shared-file or strongly coupled changes together/sequential. While children work, handle a different useful slice, not their same investigation. Consolidate when coordination costs exceed the benefit. Do not use file-count thresholds or a fixed number of agents.
Give each child the objective, relevant paths, constraints and acceptance check. Check its available capabilities: headless children cannot approve ask-policy tools. Resume an owned child for a follow-up on the same task instead of making it rediscover everything; do not reuse unrelated history. Do not bypass permissions or invent independent review.
Stop exploring when the next scoped change and its acceptance check are clear. Scouts return findings with source ranges and open questions; verify disputed/high-risk findings without repeating their whole scans. After compaction, resume from the latest checkpoint, remaining requirements and current diff; re-read only changed or missing evidence. Keep original-request/artifact pointers and child resume IDs in checkpoints. Verify the combined result against the original request. Explain the chosen split briefly only when delegation helps; no ceremony for trivial work. Ask before material ambiguity or an unapproved scope change. No commit, push or deployment without explicit user authorization.`;

/** Adaptive instructions for ordinary turns, plus explicit orchestration/gate commands. */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
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
        task = runProcess(gatesBin, [mode], {
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
