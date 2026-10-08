import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { appendAuditEvent } from "../lib/audit-events.ts";
import { auditReport, formatAuditReport } from "../lib/audit-report.ts";
import { PermissionAudit } from "../lib/permission-audit.ts";

test("timings separate prompt waits, reviews and tools with project filters and missing-pair accounting", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-audit-timing-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent"), cwd = join(root, "one"), other = join(root, "two");
  for (const path of [agent, cwd, other]) mkdirSync(path);
  const instant = offset => new Date(Date.UTC(2026, 9, 8) + offset).toISOString();
  for (const project of [cwd, other]) {
    const audit = new PermissionAudit(agent, { cwd: project, hasUI: true }, { resource: "fixture", operation: "run" });
    audit.prompted(); audit.answered("allow"); audit.finish("granted", "human");
  }
  appendAuditEvent(agent, { cwd }, "session.start", {});
  const db = new DatabaseSync(join(agent, "permission-audit/requests.sqlite"));
  t.after(() => db.close());
  db.prepare("UPDATE permission_requests SET requested_at=?, prompted_at=?, answered_at=? WHERE cwd=?").run(instant(0), instant(10), instant(1010), cwd);
  db.prepare("UPDATE permission_requests SET requested_at=?, prompted_at=?, answered_at=? WHERE cwd=?").run(instant(0), instant(10), instant(110), other);
  const event = (kind, at, toolCallId, payload = {}, changes = {}) => {
    appendAuditEvent(agent, { cwd, sessionId: "one", toolCallId, ...changes }, kind, payload);
    db.prepare("UPDATE audit_events SET created_at=?, pid=? WHERE sequence=(SELECT max(sequence) FROM audit_events)").run(instant(at), changes.pid ?? process.pid);
  };
  event("review.result", 100, "review-1", { durationMs: 200, diagnostic: { code: "provider_rate_limit" } });
  event("review.result", 101, "review-2", { durationMs: 400, diagnostic: { code: "verdict" } });
  event("review.result", 102, "review-3", { durationMs: 1, diagnostic: { code: "reviewer_cooldown" } });
  event("review.result", 103, "legacy", {});
  event("tool.start", 100, "reused", { name: "bash" });
  event("tool.end", 300, "reused", { name: "bash" });
  event("tool.end", 310, "reused", { name: "bash" }); // Duplicate end must not reuse the first start.
  event("tool.start", 400, "reused", { name: "bash" });
  event("tool.end", 450, "reused", { name: "bash" }, { sessionId: "two" });
  event("tool.end", 460, "reused", { name: "bash" }, { pid: process.pid + 1 });
  event("tool.end", 470, "reused", { name: "bash" }, { cwd: other });
  event("tool.end", 900, "reused", { name: "bash" });
  event("tool.start", 1000, undefined, { name: "bash" });
  event("tool.end", 1100, undefined, { name: "bash" }); // No call ID, no inferred pair.
  event("tool.start", 1400, "clock", { name: "bash" });
  event("tool.end", 1300, "clock", { name: "bash" }); // Clock moved backwards.
  const report = auditReport(agent, { cwd, events: 1 });
  assert.deepEqual(report.timings.review, { count: 2, totalMs: 600, medianMs: 300, p95Ms: 400, maxMs: 400 });
  assert.deepEqual(report.timings.promptWait, { count: 1, totalMs: 1000, medianMs: 1000, p95Ms: 1000, maxMs: 1000 });
  assert.deepEqual(report.timings.tools, [{ name: "bash", count: 2, totalMs: 700, medianMs: 350, p95Ms: 500, maxMs: 500, unobserved: 5 }]);
  assert.equal(report.projects.length, 1); assert.equal(report.timeline.length, 1, "timeline limits do not limit timing samples");
  const all = auditReport(agent);
  assert.equal(all.projects.length, 2); assert.equal(all.timings.promptWait.medianMs, 550);
  assert.match(formatAuditReport(all), /Prompt wait: n=2; median=550ms; p95=1000ms/);
  assert.match(formatAuditReport(all), /concurrent spans overlap/);
  const recent = auditReport(agent, { cwd, sessionId: "one", since: instant(800) });
  assert.equal(recent.timings.tools[0].count, 1, "a selected end can pair with a start before the time filter");
  assert.equal(recent.timings.tools[0].medianMs, 500);
  assert.equal(recent.timings.promptWait.count, 0); assert.equal(recent.timings.promptWait.medianMs, null);
  assert.equal(auditReport(agent, { cwd: other }).timings.tools[0].count, 0);
});
