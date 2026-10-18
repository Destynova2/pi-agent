// Global default policy (`/approvals global …`, cwd "*") applies to projects without their own policy file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAutomaticReview } from "../lib/approval-review.ts";

const policy = (cwd, mode) => JSON.stringify({ version: 1, revision: randomUUID(), cwd, mode, fallback: "ask", scope: "tests", provider: "grob", model: "think-model" });

test("global default applies without a project policy and never overrides one", () => {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-approval-global-")));
  const agentDir = join(root, "agent"), project = join(root, "project"), other = join(root, "other");
  for (const dir of [project, other]) mkdirSync(dir);
  const policies = join(agentDir, "approval-policies"); mkdirSync(policies, { recursive: true, mode: 0o700 });
  const ctx = cwd => ({ cwd });
  assert.equal(hasAutomaticReview(agentDir, ctx(project)), false, "no policy at all");

  writeFileSync(join(policies, "default.json"), policy("*", "auto"), { mode: 0o600 });
  assert.equal(hasAutomaticReview(agentDir, ctx(project)), true, "global default covers any project");
  assert.equal(hasAutomaticReview(agentDir, ctx(other)), true);

  writeFileSync(join(policies, `${createHash("sha256").update(project).digest("hex")}.json`), policy(project, "manual"), { mode: 0o600 });
  assert.equal(hasAutomaticReview(agentDir, ctx(project)), false, "project policy wins over the global default");
  assert.equal(hasAutomaticReview(agentDir, ctx(other)), true);

  writeFileSync(join(policies, "default.json"), policy(other, "auto"), { mode: 0o600 });
  assert.throws(() => hasAutomaticReview(agentDir, ctx(other)), /Invalid approval policy/, "a default file must carry cwd \"*\"");
});
