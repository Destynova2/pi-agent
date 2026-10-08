import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { appendAuditEvent, auditContext, currentAuditContext, type AuditContext } from "../../lib/audit-events.ts";
import { auditReport, formatAuditReport } from "../../lib/audit-report.ts";
import { auditUI } from "../../lib/audit-ui.ts";

export function registerAudit(pi: ExtensionAPI, agentDir: string) {
  let latest: ExtensionContext | undefined, ui: ExtensionUIContext | undefined, restore: (() => void) | undefined;
  let missing = 0;
  const failed = (_error: unknown) => {
    missing++;
    if (missing !== 1) return;
    // No raw error here: a storage error can itself contain private paths or values.
    const message = "Audit storage unavailable: event coverage is incomplete. Permission audit still fails closed. Check /audit and private storage permissions.";
    process.stderr.write(`${message}\n`);
    try { pi.appendEntry("audit_gap", { message, at: new Date().toISOString() }); } catch { /* stderr remains visible if session persistence also fails. */ }
  };
  const record = (origin: AuditContext, kind: string, payload: unknown) => {
    if (missing) {
      appendAuditEvent(agentDir, origin, "audit.gap", { missingEvents: missing, coverage: "unknown during storage failure" });
      missing = 0;
    }
    appendAuditEvent(agentDir, origin, kind, payload);
  };
  const observe = (ctx: ExtensionContext, kind: string, payload: unknown, link: Partial<AuditContext> = {}) => {
    try { record({ ...auditContext(ctx), ...link }, kind, payload); } catch (error) { failed(error); }
  };
  const attach = (ctx: ExtensionContext) => {
    latest = ctx;
    if (ui === ctx.ui) return;
    restore?.();
    ui = ctx.ui;
    restore = auditUI(ui, () => auditContext(latest!), record, failed);
  };
  pi.on("session_start", (event, ctx) => {
    attach(ctx);
    observe(ctx, "session.start", { ...event, mode: ctx.mode, interactive: ctx.hasUI, captureVersion: 1,
      coverage: "Future public UI dialogs, notifications, messages and tool events. Custom UI content and native windows are opaque; no retrospective import." });
  });
  pi.on("session_shutdown", (_event, ctx) => { observe(ctx, "session.shutdown", {}); restore?.(); restore = ui = undefined; latest = undefined; });
  pi.on("before_agent_start", (event, ctx) => { attach(ctx); observe(ctx, "prompt.user", { text: event.prompt, images: event.images }); });
  pi.on("agent_start", (_event, ctx) => observe(ctx, "prompt.system", { text: ctx.getSystemPrompt() }));
  pi.on("input", (event, ctx) => { attach(ctx); observe(ctx, "input", event); });
  pi.on("message_end", (event, ctx) => observe(ctx, "message.end", event.message));
  pi.on("tool_call", (event, ctx) => {
    attach(ctx);
    observe(ctx, "tool.call", { name: event.toolName, input: event.input }, { toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId });
  });
  pi.on("tool_execution_start", (event, ctx) => observe(ctx, "tool.start", { name: event.toolName, input: event.args }, { toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId }));
  pi.on("tool_execution_end", (event, ctx) => observe(ctx, "tool.end", { name: event.toolName, result: event.result, isError: event.isError }, { toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId }));
  // Core lifecycle events also expose dialogs that did not traverse ctx.ui.
  // Their body/options/answer are unavailable, so coverage stays explicit.
  pi.on("ui_prompt_start", (event, ctx) => observe(ctx, "ui.lifecycle.start", { ...event, coverage: "lifecycle-only" }, currentAuditContext()));
  pi.on("ui_prompt_end", (event, ctx) => observe(ctx, "ui.lifecycle.end", { ...event, coverage: "lifecycle-only" }, currentAuditContext()));
  pi.registerCommand("audit", {
    description: "/audit [session]: summarize permissions, reviewer failures and observed tool results for this project",
    async handler(args, ctx) {
      if (args.trim() && args.trim() !== "session") throw new Error("Usage: /audit [session]");
      const report = auditReport(agentDir, { cwd: ctx.cwd, ...(args.trim() === "session" ? { sessionId: ctx.sessionManager.getSessionId() } : {}) });
      ctx.ui.notify(formatAuditReport(report), "info");
    },
  });
}

export default function (pi: ExtensionAPI) { registerAudit(pi, getAgentDir()); }
