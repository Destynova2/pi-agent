#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auditReport, formatAuditReport } from "../lib/audit-report.ts";

try {
  const { values } = parseArgs({ options: {
    target: { type: "string" }, project: { type: "string" }, all: { type: "boolean" }, session: { type: "string" },
    since: { type: "string" }, events: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node scripts/audit-report.mjs [--target <agent-dir>] [--project <cwd> | --all] [--session <id>] [--since <ISO>] [--json] [--events <0..500>]\nDefault: current project, aggregate counts, no transcript output. Queries a read-only SQLite snapshot, including WAL.");
  } else {
    if (values.all && values.project) throw new Error("Choose --project or --all");
    const report = auditReport(values.target ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), {
      cwd: values.all ? undefined : values.project ?? process.cwd(), sessionId: values.session, since: values.since,
      events: values.events === undefined ? 0 : Number(values.events),
    });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatAuditReport(report));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Audit report failed");
  process.exitCode = 1;
}
