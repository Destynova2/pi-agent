// Pure tool-policy.json parsing and path-guard helpers, still used by extensions/subagent for
// dispatch scoping. The tool-call approval dialogs and task grants these once fed have been
// retired (see ../index.ts: strict sandbox, no ui.confirm/select, no tool-policy.json exceptions);
// coverage for that behavior now lives in tests/strict-sandbox.integration.test.mjs and ./pi.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_TOOL_POLICY, loadToolPolicy, MAX_POLICY_BYTES, protectedPathViolation, toolDecision } from "../core.ts";

function tempDir(policy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-policy-"));
  if (policy !== undefined) writeFileSync(join(dir, "tool-policy.json"), policy);
  return dir;
}

test("built-in policy when file absent, immutable, exact lookup", () => {
  const dir = tempDir();
  try {
    const policy = loadToolPolicy(dir);
    assert.equal(policy, DEFAULT_TOOL_POLICY);
    for (const name of ["read", "grep", "find", "ls", "edit", "write", "note_list", "note_add", "project_graph", "git_inspect", "subagent"]) assert.equal(toolDecision(policy, name), "allow");
    assert.equal(toolDecision(policy, "bash"), "ask");
    assert.equal(toolDecision(policy, "*"), "ask");
    assert.equal(toolDecision(policy, "toString"), "ask");
    assert.equal(toolDecision(policy, "__proto__"), "ask");
    assert.equal(toolDecision(policy, "READ"), "ask");
    assert.ok(Object.isFrozen(policy));
    assert.throws(() => { (policy as any).bash = "allow"; }, TypeError);
  } finally { rmSync(dir, { recursive: true }); }
});

test("existing file fully replaces built-in; absent * means ask", () => {
  const a = tempDir('{"bash":"allow","read":"deny"}');
  const b = tempDir('{"*":"deny","ls":"ask"}');
  try {
    const p = loadToolPolicy(a);
    assert.equal(toolDecision(p, "bash"), "allow");
    assert.equal(toolDecision(p, "read"), "deny");
    assert.equal(toolDecision(p, "edit"), "ask");
    assert.equal(toolDecision(p, "*"), "ask");
    assert.ok(Object.isFrozen(p));
    const q = loadToolPolicy(b);
    assert.equal(toolDecision(q, "ls"), "ask");
    assert.equal(toolDecision(q, "write"), "deny");
    assert.equal(toolDecision(q, "hasOwnProperty"), "deny");
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test("malformed, prototype-key, symlinked, oversized, non-file policies are rejected loudly", () => {
  const bad = ["{", "[]", "null", '"allow"', '{"read":"yes"}', '{"read":1}', '{"":"allow"}', '{"bad name":"allow"}',
    '{"__proto__":"allow"}', '{"constructor":"allow"}', '{"prototype":"deny"}', " ".repeat(MAX_POLICY_BYTES + 1)];
  for (const text of bad) {
    const dir = tempDir(text);
    try { assert.throws(() => loadToolPolicy(dir), /tool-policy\.json/, text.slice(0, 30)); } finally { rmSync(dir, { recursive: true }); }
  }
  const link = tempDir();
  const target = join(link, "real.json");
  writeFileSync(target, '{"*":"allow"}');
  symlinkSync(target, join(link, "tool-policy.json"));
  const folder = tempDir();
  mkdirSync(join(folder, "tool-policy.json"));
  try {
    assert.throws(() => loadToolPolicy(link), /symlink/);
    assert.throws(() => loadToolPolicy(folder), /tool-policy\.json/);
    assert.throws(() => loadToolPolicy(""), /agent directory/);
  } finally { rmSync(link, { recursive: true }); rmSync(folder, { recursive: true }); }
});

test("FIFO policy file is rejected without blocking", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const made = spawnSync("mkfifo", [join(dir, "tool-policy.json")]);
    if (made.error || made.status !== 0) throw new Error("mkfifo unavailable");
    assert.throws(() => loadToolPolicy(dir), /not a regular file/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("protectedPathViolation blocks the agent directory, symlinks into it, and unresolvable paths", () => {
  const agent = tempDir('{"*":"allow"}');
  const work = realpathSync(tempDir());
  try {
    mkdirSync(join(agent, "agents"));
    symlinkSync(agent, join(work, "link"));
    symlinkSync(join(agent, "nope", "x.json"), join(work, "dangling"));
    const blocked = [
      join(agent, "tool-policy.json"), join(agent, "agents", "new.md"), join(agent, "missing", "deep", "f.ts"),
      `@${agent}/tool-policy.json`, `file://${agent}/tool-policy.json`, join(relative(work, agent), "a"),
      "link/tool-policy.json", "link/extensions/new/index.ts", "dangling",
      "", "   ", 42, undefined, "a\0b", join(work, "file.txt", "under-a-file"),
    ];
    writeFileSync(join(work, "file.txt"), "x");
    for (const path of blocked) assert.ok(protectedPathViolation(agent, path, work), String(path));
    assert.match(protectedPathViolation(agent, "link/tool-policy.json", work)!, /protected agent directory/);
    for (const path of ["file.txt", "new/dir/x.ts", join(work, "y"), `${agent}-sibling/x`]) assert.equal(protectedPathViolation(agent, path, work), undefined, path);
    assert.ok(protectedPathViolation(agent, "x", undefined));
  } finally { rmSync(agent, { recursive: true }); rmSync(work, { recursive: true }); }
});
