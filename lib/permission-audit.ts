import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { openAuditDatabase } from "./audit-storage.ts";
import { appendAuditEvent, auditContext, withAuditContext, type AuditContext } from "./audit-events.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewRecord } from "./approval-review.ts";

type Scope = "once" | "session" | "project" | "policy";
type Source = "human" | "session" | "project" | "policy" | "refusal_cache" | "unavailable";
type Decision = "allow" | "deny" | "cancel";
type Status = "granted" | "denied" | "cancelled" | "error";
type Context = Pick<ExtensionContext, "cwd" | "hasUI"> & Partial<Pick<ExtensionContext, "sessionManager">>;

/** The payload is fingerprinted, never stored: commands, arguments and errors can contain secrets. */
interface Request {
  resource: string;
  operation: string;
  payload?: unknown;
  toolCallId?: string;
  targets?: string[];
}

/** Synchronous durable writes; no connection or transaction stays open across a human prompt. */
export class PermissionAudit {
  private readonly agentDir: string;
  private readonly cwd: string;
  private readonly id = randomUUID();
  private readonly context: AuditContext;
  private finished = false;
  private decision: Decision | undefined;

  constructor(agentDir: string, ctx: Context, request: Request) {
    this.agentDir = realpathSync(agentDir);
    this.cwd = realpathSync(ctx.cwd);
    this.context = { ...auditContext(ctx), requestId: this.id, toolCallId: request.toolCallId };
    const db = openAuditDatabase(this.agentDir, this.cwd);
    try {
      db.prepare(`INSERT INTO permission_requests
        (id, requested_at, session_id, session_file, tool_call_id, cwd, pid, resource, operation, request_sha256, targets_json, interactive)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.id, new Date().toISOString(), ctx.sessionManager?.getSessionId() ?? null,
        ctx.sessionManager?.getSessionFile() ?? null, request.toolCallId ?? null, this.cwd, process.pid,
        request.resource, request.operation,
        createHash("sha256").update(JSON.stringify(request.payload ?? null)).digest("hex"),
        JSON.stringify(request.targets ?? []), Number(ctx.hasUI),
      );
    } finally { db.close(); }
  }

  run<T>(action: () => T): T { return withAuditContext(this.context, action); }

  event(kind: string, payload: unknown) { appendAuditEvent(this.agentDir, this.context, kind, payload); }

  prompted() {
    this.update("prompted_at = ?, source = 'human'", [new Date().toISOString()]);
  }

  answered(decision: Decision, scope: Scope = "once") {
    this.update("answered_at = ?, decision = ?, scope = ?, source = 'human'", [new Date().toISOString(), decision, scope]);
    this.decision = decision;
  }

  reviewed(record: ReviewRecord) {
    const db = openAuditDatabase(this.agentDir, this.cwd);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS permission_reviews (
        request_id TEXT PRIMARY KEY REFERENCES permission_requests(id),
        reviewed_at TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        policy_sha256 TEXT NOT NULL
      )`);
      db.prepare("INSERT INTO permission_reviews VALUES (?, ?, ?, ?, ?, ?)").run(
        this.id, new Date().toISOString(), record.decision, record.category, record.model, record.policy);
      const result = db.prepare(`UPDATE permission_requests SET answered_at = ?, decision = ?, source = 'policy'
        WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), record.decision === "ask" ? null : record.decision, this.id);
      if (result.changes !== 1) throw new Error("Permission audit request missing or already completed");
      db.exec("COMMIT");
      if (record.decision !== "ask") this.decision = record.decision;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  }

  finish(status: Status, source?: Source, scope?: Scope) {
    if (this.finished) return;
    this.update("completed_at = ?, status = ?, source = COALESCE(?, source), scope = COALESCE(?, scope)",
      [new Date().toISOString(), status, source ?? null, scope ?? null]);
    this.finished = true;
  }

  fail(signal?: AbortSignal, error?: unknown) {
    if (error !== undefined) this.event("permission.error", { error, aborted: signal?.aborted ?? false, authorizationCompleted: this.finished });
    this.finish(signal?.aborted || this.decision === "cancel" ? "cancelled" : this.decision === "deny" ? "denied" : "error");
  }

  private update(set: string, values: (string | null)[]) {
    const db = openAuditDatabase(this.agentDir, this.cwd);
    try {
      const result = db.prepare(`UPDATE permission_requests SET ${set} WHERE id = ? AND status = 'pending'`).run(...values, this.id);
      if (result.changes !== 1) throw new Error("Permission audit request missing or already completed");
    } finally { db.close(); }
  }
}
