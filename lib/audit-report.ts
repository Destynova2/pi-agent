import { realpathSync } from "node:fs";
import { openAuditReader } from "./audit-storage.ts";

export interface AuditFilter { cwd?: string; sessionId?: string; since?: string; events?: number }

function durations(values: unknown[]) {
  const sorted = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const count = sorted.length, middle = Math.floor(count / 2);
  return { count, totalMs: Math.round(sorted.reduce((sum, value) => sum + value, 0)),
    medianMs: count ? Math.round(count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
    p95Ms: count ? Math.round(sorted[Math.ceil(count * 0.95) - 1]) : null, maxMs: count ? Math.round(sorted[count - 1]) : null };
}

function formatTiming(value: ReturnType<typeof durations>): string {
  return `n=${value.count}; median=${value.medianMs ?? "unknown"}ms; p95=${value.p95Ms ?? "unknown"}ms`;
}

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
    const projects = db.prepare(`SELECT cwd, count(*) AS requests, sum(prompted_at IS NOT NULL) AS prompted,
      sum(status = 'denied') AS denied, sum(status = 'cancelled') AS cancelled, sum(status = 'error') AS errors
      FROM permission_requests p WHERE ${where("p", "requested_at")} GROUP BY cwd ORDER BY requests DESC, cwd`).all(...values);
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
    const promptWait = durations(db.prepare(`SELECT prompted_at, answered_at FROM permission_requests p
      WHERE ${where("p", "requested_at")} AND prompted_at IS NOT NULL AND answered_at IS NOT NULL`).all(...values)
      .map(row => Date.parse(String(row.answered_at)) - Date.parse(String(row.prompted_at))));
    const review = durations(events ? db.prepare(`SELECT json_extract(payload_json, '$.durationMs') AS duration FROM audit_events e
      WHERE ${where("e", "created_at")} AND kind = 'review.result' AND json_extract(payload_json, '$.diagnostic.code') IS NOT 'reviewer_cooldown'`).all(...values).map(row => row.duration) : []);
    const toolRows = events ? db.prepare(`SELECT json_extract(e.payload_json, '$.name') AS name, e.created_at AS ended_at,
      (SELECT CASE WHEN s.kind = 'tool.start' AND json_extract(s.payload_json, '$.name') = json_extract(e.payload_json, '$.name') THEN s.created_at END
        FROM audit_events s WHERE s.session_id IS e.session_id AND s.cwd = e.cwd AND s.pid = e.pid AND s.tool_call_id = e.tool_call_id
        AND s.sequence < e.sequence AND s.kind IN ('tool.start', 'tool.end') ORDER BY s.sequence DESC LIMIT 1) AS started_at
      FROM audit_events e WHERE ${where("e", "created_at")} AND e.kind = 'tool.end'`).all(...values) : [];
    const byTool = new Map<string, number[]>();
    for (const row of toolRows) {
      const name = typeof row.name === "string" ? row.name : "unknown";
      const samples = byTool.get(name) ?? [];
      samples.push(row.started_at === null ? NaN : Date.parse(String(row.ended_at)) - Date.parse(String(row.started_at)));
      byTool.set(name, samples);
    }
    const tools = [...byTool].map(([name, samples]) => {
      const timing = durations(samples);
      return { name, ...timing, unobserved: samples.length - timing.count };
    }).sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || a.name.localeCompare(b.name));
    const timeline = events && limit ? db.prepare(`SELECT sequence, created_at, session_id, cwd, kind, tool_call_id, parent_tool_call_id, request_id, dialog_id, payload_json, redactions, truncated
      FROM audit_events e WHERE ${where("e", "created_at")} ORDER BY sequence DESC LIMIT ?`).all(...values, limit).reverse().map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(String(payload_json)) as unknown })) : [];
    return { available: true as const, filter: { ...filter, cwd }, summary, projects, permissions, executions, reviewer, coverage, failures, unansweredDialogs: unanswered,
      timings: { promptWait, review, tools }, timeline,
      limits: ["No historical dialog backfill; unobserved does not mean success or failure.", "Timing spans use recorded wall-clock timestamps. Tool durations include permission waits; parallel or nested spans overlap. Totals are not elapsed working time.", "Only paired, nonnegative durations are measured; skipped cooldown reviews are excluded from reviewer latency. p95 uses nearest rank.", "A successful tool result does not prove application health.", "Custom UI content, native OS/browser windows, binary media and hidden thinking are not captured.", "Known secrets are masked; unlabelled secrets may remain. Text and collections are bounded with explicit truncation."] };
  } finally { db.close(); }
}

export function formatAuditReport(report: ReturnType<typeof auditReport>): string {
  if (!report.available) return report.message;
  return [
    `Audit: ${report.filter.cwd ?? "all projects"}${report.filter.sessionId ? `; session ${report.filter.sessionId}` : ""}`,
    `Permissions: ${report.summary?.requests ?? 0}; prompted: ${report.summary?.prompted ?? 0}; pending: ${report.summary?.pending ?? 0}`,
    `Granted request outcomes: ${report.executions.map(row => `${row.outcome}=${row.count}`).join(", ") || "none"}`,
    `Reviewer: ${report.reviewer.map(row => `${row.decision}/${row.category}/${row.diagnostic}=${row.count}`).join(", ") || "none"}`,
    ...(!report.filter.cwd ? report.projects.map(row => `${row.cwd}: ${row.requests} requests; ${row.prompted} prompted; ${row.denied} denied; ${row.cancelled} cancelled; ${row.errors} errors`) : []),
    `Reviewer latency: ${formatTiming(report.timings.review)}`,
    `Prompt wait: ${formatTiming(report.timings.promptWait)}`,
    ...report.timings.tools.slice(0, 5).map(row => `Tool ${row.name}: ${formatTiming(row)}; unobserved=${row.unobserved}`),
    "Tool durations include prompt waits; concurrent spans overlap. Timing totals are not elapsed working time.",
    `Capture: ${report.coverage?.events ?? 0} events; ${report.coverage?.redactions ?? 0} masked values; ${report.coverage?.truncated ?? 0} bounded records; ${report.coverage?.opaque_dialogs ?? 0} opaque dialogs; ${report.unansweredDialogs ?? 0} dialogs without a recorded answer`,
    `Failures: ${report.failures.map(row => `${row.kind}=${row.count}`).join(", ") || "none recorded"}`,
    ...report.permissions.filter(row => row.status !== "granted").map(row => `${row.resource}/${row.operation}: ${row.status} (${row.source ?? "unknown"}) x${row.count}`),
    "Use --json --events 100 for the correlated timeline. Unobserved outcomes and historical missing causes remain unknown.",
  ].join("\n");
}
