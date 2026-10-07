import { realpathSync } from "node:fs";
import { openAuditReader } from "./audit-storage.ts";

export interface AuditFilter { cwd?: string; sessionId?: string; since?: string; events?: number }

/** Aggregates the entire selected history; only the optional timeline is limited. */
export function auditReport(agentDir: string, filter: AuditFilter = {}) {
  const limit = filter.events ?? 0;
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) throw new Error("Event limit must be between 0 and 500");
  if (filter.since && (!/^\d{4}-\d\d-\d\dT/.test(filter.since) || !Number.isFinite(Date.parse(filter.since)))) throw new Error("since must be an ISO timestamp");
  const cwd = filter.cwd ? realpathSync(filter.cwd) : undefined;
  const since = filter.since ? new Date(filter.since).toISOString() : undefined;
  const values = [cwd, filter.sessionId, since].filter((value): value is string => value !== undefined);
  const where = (alias: string, timestamp: string) => [cwd !== undefined && `${alias}.cwd = ?`, filter.sessionId !== undefined && `${alias}.session_id = ?`, since !== undefined && `${alias}.${timestamp} >= ?`].filter(Boolean).join(" AND ") || "1";
  const db = openAuditReader(agentDir);
  if (!db) return { available: false as const, filter: { ...filter, cwd }, message: "No audit database yet. Capture starts after Pi reloads the audit extension." };
  try {
    const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const events = exists("audit_events"), reviews = exists("permission_reviews");
    const summary = db.prepare(`SELECT count(*) AS requests, sum(prompted_at IS NOT NULL) AS prompted,
      sum(status = 'pending') AS pending, min(requested_at) AS first_request, max(requested_at) AS last_request
      FROM permission_requests p WHERE ${where("p", "requested_at")}`).get(...values);
    const permissions = db.prepare(`SELECT resource, operation, status, source, count(*) AS count
      FROM permission_requests p WHERE ${where("p", "requested_at")}
      GROUP BY resource, operation, status, source ORDER BY count DESC, resource`).all(...values);
    const outcome = events ? `(SELECT CASE json_extract(e.payload_json, '$.isError') WHEN 1 THEN 'failed' WHEN 0 THEN 'succeeded' ELSE 'unobserved' END
      FROM audit_events e WHERE e.kind = 'tool.end' AND e.session_id IS p.session_id AND e.tool_call_id = p.tool_call_id AND e.pid = p.pid
      AND e.created_at >= p.requested_at ORDER BY e.sequence DESC LIMIT 1)` : "NULL";
    const executions = db.prepare(`SELECT COALESCE(${outcome}, 'unobserved') AS outcome, count(*) AS count
      FROM permission_requests p WHERE p.status = 'granted' AND ${where("p", "requested_at")} GROUP BY 1 ORDER BY 1`).all(...values);
    const reviewer = reviews ? db.prepare(`SELECT r.decision, r.category,
      ${events ? "COALESCE((SELECT json_extract(e.payload_json, '$.diagnostic.code') FROM audit_events e WHERE e.request_id = p.id AND e.kind = 'review.result' ORDER BY e.sequence DESC LIMIT 1), 'not_recorded')" : "'not_recorded'"} AS diagnostic,
      count(*) AS count FROM permission_reviews r JOIN permission_requests p ON p.id = r.request_id
      WHERE ${where("p", "requested_at")} GROUP BY 1, 2, 3 ORDER BY count DESC`).all(...values) : [];
    const coverage = events ? db.prepare(`SELECT count(*) AS events, min(created_at) AS first_event, max(created_at) AS last_event,
      sum(redactions) AS redactions, sum(truncated) AS truncated, sum(kind = 'audit.gap') AS recovered_gaps,
      sum(kind = 'dialog.open' AND json_extract(payload_json, '$.coverage') = 'opaque-custom-ui') AS opaque_dialogs
      FROM audit_events e WHERE ${where("e", "created_at")}`).get(...values) : { events: 0 };
    const failures = events ? db.prepare(`SELECT kind, count(*) AS count FROM audit_events e WHERE ${where("e", "created_at")}
      AND (kind IN ('permission.error', 'dialog.error', 'review.invalidated', 'audit.gap') OR kind = 'tool.end' AND json_extract(payload_json, '$.isError') = 1)
      GROUP BY kind ORDER BY count DESC`).all(...values) : [];
    const unanswered = events ? db.prepare(`SELECT count(*) AS count FROM audit_events e WHERE e.kind = 'dialog.open' AND ${where("e", "created_at")}
      AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.dialog_id = e.dialog_id AND a.kind IN ('dialog.answer', 'dialog.error'))`).get(...values)?.count : 0;
    const timeline = events && limit ? db.prepare(`SELECT sequence, created_at, session_id, cwd, kind, tool_call_id, parent_tool_call_id, request_id, dialog_id, payload_json, redactions, truncated
      FROM audit_events e WHERE ${where("e", "created_at")} ORDER BY sequence DESC LIMIT ?`).all(...values, limit).reverse().map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(String(payload_json)) as unknown })) : [];
    return { available: true as const, filter: { ...filter, cwd }, summary, permissions, executions, reviewer, coverage, failures, unansweredDialogs: unanswered, timeline,
      limits: ["No historical dialog backfill; unobserved does not mean success or failure.", "A successful tool result does not prove application health.", "Custom UI content, native OS/browser windows, binary media and hidden thinking are not captured.", "Known secrets are masked; unlabelled secrets may remain. Text and collections are bounded with explicit truncation."] };
  } finally { db.close(); }
}

export function formatAuditReport(report: ReturnType<typeof auditReport>): string {
  if (!report.available) return report.message;
  return [
    `Audit: ${report.filter.cwd ?? "all projects"}${report.filter.sessionId ? `; session ${report.filter.sessionId}` : ""}`,
    `Permissions: ${report.summary?.requests ?? 0}; prompted: ${report.summary?.prompted ?? 0}; pending: ${report.summary?.pending ?? 0}`,
    `Granted request outcomes: ${report.executions.map(row => `${row.outcome}=${row.count}`).join(", ") || "none"}`,
    `Reviewer: ${report.reviewer.map(row => `${row.decision}/${row.category}/${row.diagnostic}=${row.count}`).join(", ") || "none"}`,
    `Capture: ${report.coverage?.events ?? 0} events; ${report.coverage?.redactions ?? 0} masked values; ${report.coverage?.truncated ?? 0} bounded records; ${report.coverage?.opaque_dialogs ?? 0} opaque dialogs; ${report.unansweredDialogs ?? 0} dialogs without a recorded answer`,
    `Failures: ${report.failures.map(row => `${row.kind}=${row.count}`).join(", ") || "none recorded"}`,
    ...report.permissions.filter(row => row.status !== "granted").map(row => `${row.resource}/${row.operation}: ${row.status} (${row.source ?? "unknown"}) x${row.count}`),
    "Use --json --events 100 for the correlated timeline. Unobserved outcomes and historical missing causes remain unknown.",
  ].join("\n");
}
