import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

// Unlike gitInspect's core tests, this tool launches the real Codex sandbox.
test("registered tool uses ctx.cwd, propagates git errors and aborts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-tool-"));
  const repo = join(root, "repo");
  try {
    mkdirSync(join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "sub/b.txt"), "bee\n");
    let tool: any;
    extension({ registerTool: (value: any) => { tool = value; } } as any);
    assert.equal(tool.name, "git_inspect");
    assert.deepEqual(tool.parameters.properties.operation.anyOf.map((s: any) => s.const), ["status", "diff", "log", "files"]);
    const result = await tool.execute("id", { operation: "files", paths: ["sub"] }, undefined, undefined, { cwd: repo });
    assert.equal(result.content[0].text, "sub/b.txt");
    await assert.rejects(tool.execute("id", { operation: "status" }, undefined, undefined, { cwd: root }), /git_inspect status failed|not a git repository/);
    await assert.rejects(tool.execute("id", { operation: "status" }, AbortSignal.abort(), undefined, { cwd: repo }), /cancel/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
