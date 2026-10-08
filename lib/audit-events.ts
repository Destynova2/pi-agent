import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openAuditDatabase } from "./audit-storage.ts";
import { redactAudit } from "./audit-redaction.ts";

export interface AuditContext {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  requestId?: string;
  dialogId?: string;
}

const links = new AsyncLocalStorage<AuditContext>();
export const currentAuditContext = () => links.getStore();
export const withAuditContext = <T>(context: AuditContext, action: () => T): T => links.run(context, action);

export function auditContext(ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "sessionManager">>): AuditContext {
  return { cwd: realpathSync(ctx.cwd), sessionId: ctx.sessionManager?.getSessionId(), sessionFile: ctx.sessionManager?.getSessionFile() };
}

/** Append-only observations, never an authorization source. Each write is durable before returning. */
export function appendAuditEvent(agentDir: string, context: AuditContext, kind: string, payload: unknown): void {
  const safe = redactAudit(payload);
  const db = openAuditDatabase(agentDir, context.cwd);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      session_id TEXT,
      session_file TEXT,
      cwd TEXT NOT NULL,
      pid INTEGER NOT NULL,
      kind TEXT NOT NULL,
      tool_call_id TEXT,
      parent_tool_call_id TEXT,
      request_id TEXT,
      dialog_id TEXT,
      payload_json TEXT NOT NULL,
      redactions INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS audit_events_session ON audit_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS audit_events_tool ON audit_events(session_id, tool_call_id, sequence);
    CREATE INDEX IF NOT EXISTS audit_events_request ON audit_events(request_id, sequence);
    CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events(cwd, sequence);`);
    db.prepare(`INSERT INTO audit_events
      (id, created_at, session_id, session_file, cwd, pid, kind, tool_call_id, parent_tool_call_id, request_id, dialog_id, payload_json, redactions, truncated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), new Date().toISOString(), context.sessionId ?? null, context.sessionFile ?? null, context.cwd, process.pid, kind,
      context.toolCallId ?? null, context.parentToolCallId ?? null, context.requestId ?? null, context.dialogId ?? null,
      JSON.stringify(safe.value), safe.redactions, Number(safe.truncated),
    );
  } finally { db.close(); }
}
