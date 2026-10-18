import { realpathSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const entryType = "task_checkpoint_v1";
const contextType = "task_checkpoint_context";
type Item = { id: string; requirement: string; status: "pending" | "in_progress" | "done" | "blocked" | "deferred"; evidence?: string };
type Checkpoint = { version: 1; cwd: string; task: string; items: Item[]; supersedes?: string };
const statuses = ["pending", "in_progress", "done", "blocked", "deferred"];

function validateItems(items: Item[]) {
  if (!Array.isArray(items) || !items.length || items.length > 32) throw new Error("Expected 1–32 requirements");
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(item.id) || ids.has(item.id)) throw new Error("Unique stable requirement IDs are required");
    ids.add(item.id);
    if (typeof item.requirement !== "string" || !item.requirement.trim() || item.requirement.length > 600 || !statuses.includes(item.status)) throw new Error("Invalid requirement/status");
    if (item.evidence !== undefined && (typeof item.evidence !== "string" || item.evidence.length > 1000)) throw new Error("Evidence must be bounded text");
    if (["done", "blocked", "deferred"].includes(item.status) && !item.evidence?.trim()) throw new Error("Done needs verification evidence; blocked/deferred needs its reason and next action");
  }
}

function restore(ctx: ExtensionContext): Checkpoint | undefined {
  const cwd = realpathSync(ctx.cwd);
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const state = entry.data as Checkpoint;
    if (!state || state.version !== 1 || state.cwd !== cwd || typeof state.task !== "string" || !state.task.trim() || state.task.length > 600) throw new Error("Invalid task checkpoint for this workspace; inspect session history");
    validateItems(state.items);
    return structuredClone(state);
  }
}

/** Bounded automatic continuation, armed only by a human (`/task-rounds`); process-local, never persisted. */
type Rounds = { max: number; used: number; last?: string };
export const MAX_ROUNDS = 10;
const open = (state: Checkpoint) => state.items.filter(item => item.status === "pending" || item.status === "in_progress");

/** Decides the next round after a turn: a user message to queue, a reason to stop, or nothing. */
export function nextRound(rounds: Rounds, state: Checkpoint | undefined): { message?: string; stop?: string } {
  const remaining = state ? open(state) : [];
  if (!state || !remaining.length) return { stop: "every checkpoint item is done, blocked or deferred" };
  const digest = JSON.stringify(state.items);
  if (rounds.last !== undefined && digest === rounds.last) return { stop: "the last round changed no checkpoint item" };
  if (rounds.used >= rounds.max) return { stop: `the ${rounds.max}-round budget is used up` };
  rounds.used++; rounds.last = digest;
  return { message: `Automatic continuation round ${rounds.used}/${rounds.max}, armed by the user with /task-rounds; it is not new authorization or scope. Open checkpoint items: ${remaining.map(item => `${item.id} (${item.status})`).join(", ")}. Continue the authorized work and update task_checkpoint with evidence. If an item is genuinely blocked or needs the user, mark it blocked/deferred with its reason and stop.` };
}

export default function register(pi: ExtensionAPI) {
  const subagents = new Set<string>();
  let rounds: Rounds | undefined;
  const disarm = () => { rounds = undefined; };
  pi.on("agent_end", (event, ctx) => {
    if (!rounds) return;
    const last = event.messages?.at(-1);
    // agent_end also fires after an interrupted or failed turn; a queued round would land in the user's next prompt.
    const next = last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error") ? { stop: `the turn ${last.stopReason === "aborted" ? "was interrupted" : "ended with an error"}` } : nextRound(rounds, restore(ctx));
    if (next.message) return pi.sendUserMessage(next.message, { deliverAs: "followUp" });
    disarm();
    ctx.ui.notify(`Automatic continuation stopped: ${next.stop}.`, "info");
  });
  pi.registerCommand("task-rounds", {
    description: `/task-rounds <1-${MAX_ROUNDS}> | off: let the agent continue open checkpoint items for at most N extra turns; stops on no progress`,
    handler: async (args, ctx) => {
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Only the human in the interactive parent can arm continuation rounds");
      const value = args.trim();
      if (value === "off") { disarm(); return ctx.ui.notify("Automatic continuation disarmed.", "info"); }
      const max = Number(value);
      if (!Number.isInteger(max) || max < 1 || max > MAX_ROUNDS) throw new Error(`Usage: /task-rounds <1-${MAX_ROUNDS}> | off`);
      rounds = { max, used: 0 };
      ctx.ui.notify(`Up to ${max} automatic continuation round(s) armed for this session's checkpoint. Each round is a queued user turn; a round with no checkpoint change stops it. /task-rounds off disarms.`, "info");
    },
  });
  const refresh = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const state = restore(ctx);
    const lines: string[] = [];
    if (state) {
      const done = state.items.filter(item => item.status === "done").length;
      const blocked = state.items.filter(item => item.status === "blocked").length;
      lines.push(`Tasks: ${done}/${state.items.length} done${blocked ? ` · ${blocked} blocked` : ""} · /task-status`);
    }
    if (subagents.size) lines.push(`Delegations running: ${subagents.size}`);
    ctx.ui.setWidget("task-progress", lines.length ? lines : undefined);
  };
  pi.on("session_start", (_event, ctx) => { subagents.clear(); disarm(); refresh(ctx); });
  pi.on("session_tree", (_event, ctx) => { disarm(); refresh(ctx); });
  pi.on("session_compact", (_event, ctx) => refresh(ctx));
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName === "subagent") { subagents.add(event.toolCallId); refresh(ctx); }
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (subagents.delete(event.toolCallId)) refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    subagents.clear(); disarm();
    if (ctx.mode === "tui") ctx.ui.setWidget("task-progress", undefined);
  });
  pi.registerTool({
    name: "task_checkpoint", label: "Task requirements and evidence", executionMode: "sequential",
    description: "Persist the full multi-part request as a bounded checklist in this Pi session. update merges by stable ID; omitted requirements remain open. start replaces a completed checklist; supersedes must cite an explicit user scope change when unfinished work remains. This stores reported progress, never grants permission or proves completion. No shell or external writes.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("update")]),
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
      supersedes: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      items: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 48 }), requirement: Type.String({ minLength: 1, maxLength: 600 }),
        status: Type.Union(statuses.map(value => Type.Literal(value))),
        evidence: Type.Optional(Type.String({ maxLength: 1000 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const request = structuredClone(input);
      validateItems(request.items as Item[]);
      const previous = restore(ctx);
      let state: Checkpoint;
      if (request.action === "start") {
        if (!request.task?.trim() || request.task.length > 600) throw new Error("A task title is required");
        if (previous?.items.some(item => item.status !== "done" && item.status !== "deferred") && !request.supersedes?.trim()) throw new Error("Unfinished requirements remain. Update them or cite the user's explicit replacement/cancellation in supersedes");
        state = { version: 1, cwd: realpathSync(ctx.cwd), task: request.task, items: request.items as Item[], ...(request.supersedes ? { supersedes: request.supersedes } : {}) };
      } else if (request.action === "update") {
        if (!previous || request.task !== undefined || request.supersedes !== undefined) throw new Error("update requires an existing task and cannot replace its scope");
        const items = new Map(previous.items.map(item => [item.id, item]));
        for (const item of request.items as Item[]) {
          if (items.has(item.id) && items.get(item.id)!.requirement !== item.requirement) throw new Error("Keep the original requirement; add a new ID for new scope");
          items.set(item.id, item);
        }
        state = { ...previous, items: [...items.values()] };
      } else throw new Error("Unknown checkpoint action");
      validateItems(state.items);
      signal?.throwIfAborted();
      pi.appendEntry(entryType, state);
      refresh(ctx);
      return { content: [{ type: "text", text: JSON.stringify(state) }], details: undefined };
    },
  });
  pi.on("before_agent_start", event => {
    if (!pi.getActiveTools().includes("task_checkpoint")) return;
    event.systemPromptOptions.sections.task_progress = "For multi-part implementation work, use task_checkpoint at the start to capture EVERY requested outcome and its acceptance check. Update after meaningful verification or a blocker. Authorization already given persists; routine fixes, dependencies and tests needed for that scope do not require a new conversational confirmation. Actual capability approval gates still apply. Before finishing, reconcile every checkpoint item with evidence, including install, activation and application checks when requested. Blocked items stay open while independent work continues. Use supersedes only for an explicit user replacement/cancellation. Record verified reusable lessons in note_add; do not self-edit the installed runtime or permission policy as an automatic response to failures.";
  });
  // Read the current branch every time: reload, compaction, forks and tree navigation
  // cannot accidentally keep a different branch's completed/unfinished state in RAM.
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === contextType));
    const state = restore(ctx);
    if (state) messages.push({ role: "custom", customType: contextType, display: false, timestamp: 0,
      content: `Task checkpoint (reported state, not new authorization). Verify the evidence against current files. Continue open authorized work; report exact blockers.\n${JSON.stringify(state)}` });
    return { messages };
  });
  pi.registerCommand("task-status", {
    description: "Show the current session's full requirement checklist and evidence",
    handler: async (_args, ctx) => {
      const state = restore(ctx);
      ctx.ui.notify(state ? `${state.task}\n${state.items.map(item => `[${item.status}] ${item.id}: ${item.requirement}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")}` : "No task checkpoint in this session branch.", "info");
    },
  });
}
