import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { join } from "node:path";
import { recommendedWorkspace, workspaceHint } from "./workspace.ts";

/**
 * Prefix for `/orchestrate <request>`. The current agent acts as the chef:
 * it sizes the task, delegates through the `subagent` tool when that pays off,
 * gets an independent review from another model family, and stops cleanly.
 */
const ORCHESTRATE_PROMPT = `You are taking charge of the request below. You are the chef: you decide, you delegate when it pays off, you never bluff. This instruction guides your reasoning; it is not a workflow engine or a global session tracker.

Start by exploring the repository, its rules and context read-only before guessing paths or technical criteria. Then write a provisional KERNEL in six lines: CONTEXT, TASK, WRITE-SET, CONSTRAINTS, VERIFY (command or observable criterion), OUTPUT. Audit or read-only review: VERIFY = findings with file:line, OUTPUT = report with no modification. If substantial ambiguity of intent remains, only then run a pre-mortem: two parallel consultations, openai-codex/gpt-6-astra and anthropic/claude-fable-5-1, with the raw request, the KERNEL and the question "what other reading is plausible, and which one did the user probably want?". Their agreement is not proof: at the slightest remaining doubt, ask a grouped question with the readings before any edit. If one is unavailable, ask the user directly; never simulate this consultation. This exception is allowed at tier S, but no worker gets it. A request with distinct write-sets or verifications gets a KERNEL numbered per task.

Before any edit, verify claims and attributions; for a mechanical fix outside the write-set, reattribute or sequence the work before the edit, extend the write-set and give the reviewer their union with the attributions. Never disguise a functional change as a mechanical fix. Write a plan note, never a done note before the work. A git/jj reference in a note is neither a snapshot nor a backup: never promise full restoration and never use \`git checkout\` as a rollback. An explicit jj capture is possible only if it is relevant and verified; never restore globally or automatically, nor by overwriting other agents' work. In git, protect or isolate preexisting dirty work, or ask before acting.

Then size the task:
- S (1-2 files, local change, understood after a few reads): do it yourself, without a worker.
- M/L: read-only scout, short plan with write-sets and verifications, disjoint workers in parallel or sequenced, then a reviewer from another family. The reviewer gets the task, the evidence, the union of write-sets and their attributions. One fix after DENY then re-review; a second identical DENY, ESCALATE or a stall with no progress: stop and report.
If \`subagent\` is unavailable, do not downgrade an M/L task to S: report the limitation, stop, and never invent a review or delegation.

Model choice per subtask (\`model\` parameter of \`subagent\`, provider/id format), the cheapest sufficient one: simple recon/tests openai-codex/gpt-5.6-luna or anthropic/claude-haiku-4-5; routine implementation anthropic/claude-sonnet-5; hard openai-codex/gpt-5.6-sol or anthropic/claude-opus-5-5; reviewer from another family. The chef's model is forbidden as worker; anthropic/claude-fable-5-1 remains explicitly allowed for the pre-mortem consultation, even if the chef is Fable. State model and reason in one line per subtask.

Fixed rules:
- No claim without evidence: cite the command and its real output. Wait for local tests to finish and their real exit code; do not use a \`grep\`/\`tail\` pipeline that would mask that exit code.
- Follow AGENTS.md and conventions. Escalate without acting: dependency, CI workflow, test removal, secret, non-mechanical diff > 200 lines, or functional change outside the write-set.
- No push, merge or commit without explicit request. For remote CI after a push with a PR, run \`ci_watch\` then hand back with a status clearly "pending", not final. Without a PR, report the tool's limitation without claiming to monitor it.
- "Approved" is a reviewer's named verdict, never your own.

Finish with the retained interpretations, what was done, the evidence, what remains or blocks, and the tier/agents actually used.

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
