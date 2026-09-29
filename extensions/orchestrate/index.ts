import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { join } from "node:path";
import { recommendedWorkspace, workspaceHint } from "./workspace.ts";

/**
 * Prefix for `/orchestrate <request>`. The current agent acts as the chef:
 * it adapts effort to complexity and risk, delegates only when useful,
 * and requests independent review for risky changes.
 */
const ORCHESTRATE_PROMPT = `Take ownership of the request below. Explore first, delegate only when useful, and never invent progress. These are reasoning instructions, not a workflow engine or a global session tracker.

Read the relevant code, repository rules and context before editing. If intent remains materially ambiguous, ask the user directly before acting. For audits, stay read-only and cite file:line findings.

Adapt effort to complexity and risk, not file count. Handle a simple, low-risk task directly without a formal planning template or mandatory delegation. For complex or risky work, give a short plan with scope, owners and checks; record it in shared notes when available. Use a read-only scout or bounded workers only when they help, with disjoint write-sets or sequential edits. Request an independent reviewer for risky changes, preferably from another model family, and provide the full diff, scope, ownership and test evidence.

Use configured agent models; verify availability before delegating and choose the least costly suitable available model. If delegation or independent review is needed but unavailable, explain the limitation and ask whether to continue solo; wait for the user's answer. Never present solo work as independently reviewed. After review findings, fix and re-review; stop and report on a repeated rejection, escalation or lack of progress.

Before edits, check other agents' claims and protect preexisting changes. Reassign or sequence overlapping work and update scope before expanding it. Ask before unapproved dependency, CI, test-removal, secret-handling or functional scope changes. Never overwrite another agent's work or restore the whole worktree automatically. A git/jj reference in a note is not a backup.

Verify with real checks: wait for completion, preserve exit codes, and report failures or skipped checks. Never hide failures behind output-filtering pipelines. No commit, push, merge or deployment without explicit user authorization; a review verdict does not authorize deployment. After a push with a PR, use ci_watch when available and report pending CI as pending; otherwise state that CI is not being watched. Attribute any approval to the actual reviewer.

Finish briefly: what changed, checks and results, remaining risks or blockers, and any agents actually used. Keep routine work concise; do not claim completion before verification.

Request:
`;

/** Free-form request to the current agent, or explicit execution of local gates. */
export default function (pi: ExtensionAPI) {
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
