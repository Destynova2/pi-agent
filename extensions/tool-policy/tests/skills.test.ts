// Pure taskDecision skill-path scoping, still used by extensions/subagent. The "task" action
// this once fed into ../index.ts's approval prompts has been retired along with tool-policy.json
// exceptions (strict sandbox denies without asking); see tests/strict-sandbox.integration.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDecision } from "../task.ts";

test("installed skill Markdown reads are recognized by taskDecision, including linked collections; other actions still ask", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skill-policy-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  const source = join(root, "installed-collection");
  try {
    for (const dir of [cwd, join(agent, "skills/local"), join(source, "example/references")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(agent, "skills/local/SKILL.md"), "Local skill");
    writeFileSync(join(source, "example/SKILL.md"), "Installed skill");
    writeFileSync(join(source, "example/references/guide.md"), "Reference");
    writeFileSync(join(source, "example/script.ts"), "Source");
    writeFileSync(join(root, "private.md"), "Private");
    symlinkSync(source, join(agent, "skills/collection"));
    symlinkSync(join(root, "private.md"), join(source, "example/escape.md"));
    linkSync(join(root, "private.md"), join(source, "example/hardlink.md"));
    const skill = join(agent, "skills/collection/example/SKILL.md");
    for (const path of [skill, `@${skill}`, `file://${skill}`, join(agent, "skills/local/SKILL.md"), join(agent, "skills/collection/example/references/guide.md")]) {
      assert.equal(taskDecision("read", { path }, cwd, agent).action, "allow", path);
    }
    for (const path of [join(root, "private.md"), join(agent, "auth.json"), join(agent, "skills/collection/example/escape.md"), join(agent, "skills/collection/example/hardlink.md"), join(agent, "skills/collection/example/script.ts"), join(agent, "skills/collection/missing.md")]) {
      assert.equal(taskDecision("read", { path }, cwd, agent).action, "ask", path);
    }
    for (const name of ["write", "edit"]) assert.equal(taskDecision(name, { path: skill }, cwd, agent).action, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
