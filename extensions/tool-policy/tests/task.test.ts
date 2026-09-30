// Pure taskDecision/taskPathReason scoping rules, still used by extensions/subagent to bound
// delegated cwd and tool set. The task-grant approval flow these rules once fed inside
// ../index.ts has been retired (strict sandbox, no ui.select, no tool-policy.json "task" action);
// see tests/strict-sandbox.integration.test.mjs and ./pi.test.mjs for the current index.ts coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDecision, taskPathReason } from "../task.ts";

test("task rules recognize only scoped routine operations; scripts and shell tricks ask", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-rules-")));
  try {
    writeFileSync(join(root, "source.ts"), "example");
    mkdirSync(join(root, "dir"));
    for (const command of ["pwd", "ls -lah .", "ls 'dir'", 'ls "dir"', "wc -l source.ts", "head -n 12 source.ts", "tail -n 5 source.ts", "find . -maxdepth 3 -type f", "rg --files .", "rg -n example source.ts"]) {
      assert.equal(taskDecision("bash", { command }, root).action, "allow", command);
    }
    for (const command of ["node -e 'process.exit()'", "rm -rf dir", "git push", "npm publish", "terraform apply", "curl example.org", "sudo ls", "ls; rm -rf dir", "ls && rm -rf dir", "ls | sh", "ls > output", "ls $(pwd)", "ls `pwd`", "ls\nrm x", "ls &", "ls *", "ls ${HOME}", "find . -exec sh cmd", "find . -delete", "find -L .", "rg --pre sh x source.ts", "rg x .", "rg --files ..", "ls ../", "ls /", "ls .env", "head -n 1 .env", "tail -f source.ts", "ls --color=always", "ls 'dir", "l's'", "PATH=. ls", "env ls", "./ls", "node --test ../outside.ts"]) {
      assert.equal(taskDecision("bash", { command }, root).action, "ask", command);
    }
    for (const command of ["npm run check", "npm run test", "node --test source.ts"]) assert.equal(taskDecision("bash", { command }, root).action, "test");
    for (const name of ["read", "write", "edit", "grep"]) assert.equal(taskDecision(name, { path: "source.ts" }, root).action, "allow");
    assert.equal(taskDecision("grep", { pattern: "token" }, root).action, "ask");
    for (const name of ["ls", "find"]) assert.equal(taskDecision(name, {}, root).action, "allow");
    assert.equal(taskDecision("unknown", {}, root).action, "ask");
    for (const path of ["../other", ".env", ".env.local", ".ssh/key", ".git/config", ".pi/extensions/foo.ts", "auth.json", "credentials.json", "private.pem"]) assert.ok(taskPathReason(path, root), path);
    symlinkSync(tmpdir(), join(root, "outside"));
    assert.ok(taskPathReason("outside/file", root));
    symlinkSync(join(root, ".env"), join(root, "dangling"));
    assert.ok(taskPathReason("dangling", root));
    linkSync(join(root, "source.ts"), join(root, "hardlink"));
    assert.ok(taskPathReason("hardlink", root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
