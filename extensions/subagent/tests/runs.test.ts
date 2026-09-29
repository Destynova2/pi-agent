import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openRun } from "../runs.ts";

function fixture(fn: (request: any, dir: string) => void) {
  const dir = fs.mkdtempSync(join(tmpdir(), "pi-resume-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const agentFile = join(dir, "worker.md");
  fs.writeFileSync(agentFile, "worker");
  try { fn({ parentSession: "parent", agent: "worker", agentFile, cwd: dir, tools: ["read", "write"] }, dir); }
  finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("native session survives reopening; attempts stay separate and permissions can only narrow", () => fixture((request) => {
  const first = openRun(request);
  const native = SessionManager.open(first.sessionPath);
  native.appendMessage({ role: "user", content: "remember this", timestamp: Date.now() });
  assert.equal(fs.statSync(first.sessionPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dirname(first.sessionPath)).mode & 0o777, 0o700);
  assert.throws(() => openRun({ ...request, resume: first.id }), /active|crash lock/);
  first.release(); first.release();
  const second = openRun({ ...request, tools: ["read"], resume: first.id });
  assert.equal(second.sessionPath, first.sessionPath);
  assert.notEqual(second.attemptDir, first.attemptDir);
  assert.deepEqual(second.tools, ["read"]);
  assert.match(JSON.stringify(SessionManager.open(second.sessionPath).getBranch()), /remember this/);
  second.release();
  const third = openRun({ ...request, resume: first.id });
  assert.deepEqual(third.tools, ["read"]);
  third.release();
}));

test("resume rejects foreign owners, traversal, role/cwd mismatch and stale locks without changing history", () => fixture((request, dir) => {
  const first = openRun(request); first.release();
  const before = fs.readFileSync(first.sessionPath, "utf8");
  for (const change of [{ parentSession: "other" }, { agent: "other" }, { cwd: tmpdir() }, { agentFile: first.sessionPath }]) {
    assert.throws(() => openRun({ ...request, resume: first.id, ...change }), /does not match/);
  }
  for (const resume of ["../escape", first.sessionPath, "run-missing"]) {
    assert.throws(() => openRun({ ...request, resume }), /Invalid resume/);
  }
  fs.writeFileSync(join(dirname(first.sessionPath), "active.lock"), '{"supervisorPid":99999999}');
  assert.throws(() => openRun({ ...request, resume: first.id }), /crash lock/);
  assert.equal(fs.readFileSync(first.sessionPath, "utf8"), before);
}));

test("corrupt/missing/oversized/symlinked session data fails closed; no automatic repair", () => fixture((request, dir) => {
  const first = openRun(request); first.release();
  const before = fs.readFileSync(first.sessionPath, "utf8");
  for (const text of ["", before + '{"partial":', before.replace('"version":3', '"version":99'), before.replace('"type":"session"', '"type":"message"')]) {
    fs.writeFileSync(first.sessionPath, text);
    assert.throws(() => openRun({ ...request, resume: first.id }));
    assert.equal(fs.readFileSync(first.sessionPath, "utf8"), text);
  }
  fs.truncateSync(first.sessionPath, 65 * 1024 * 1024);
  assert.throws(() => openRun({ ...request, resume: first.id }), /oversized/);
  fs.unlinkSync(first.sessionPath);
  assert.throws(() => openRun({ ...request, resume: first.id }), /ENOENT/);
  const outside = join(dir, "outside.jsonl"); fs.writeFileSync(outside, before);
  fs.symlinkSync(outside, first.sessionPath);
  assert.throws(() => openRun({ ...request, resume: first.id }));
  assert.equal(fs.readFileSync(outside, "utf8"), before);
}));
