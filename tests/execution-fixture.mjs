import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExecution } from "../extensions/tool-policy/execution.ts";
import { registerApprovalReview } from "../lib/approval-review.ts";
import { sandboxBackend } from "../scripts/codex-shell.mjs";
import { isolatedRuntime, snapshotCommand } from "../lib/isolated-command.ts";
import { prepareExecution } from "../lib/execution-plan.ts";
export function executionFixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-execution-test-"))), cwd = join(root, "project"), agent = join(root, "agent");
  for (const path of [cwd, agent, join(root, "output")]) mkdirSync(path);
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const tools = new Map(), handlers = new Map(), commands = new Map(), reviews = [], runs = [], notices = [];
  let answer = { decision: "allow", category: "within_scope" }, review;
  const messages = [{ type: "message", message: { role: "user", content: "Run and verify the requested local tests with exact resources; do not change Git metadata or launch persistent services." } }];
  const ctx = { cwd, hasUI: false, model: { provider: "fixture", id: "reviewer" },
    sessionManager: { getBranch: () => messages, getSessionId: () => "session", getSessionFile: () => undefined },
    modelRegistry: { find: () => ctx.model, streamSimple(model, context) { reviews.push(context); return { result: async () => review ? review() : { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(answer) }] } }; } },
    ui: { confirm() { assert.fail("no human dialog"); }, select() { assert.fail("no human dialog"); }, notify() {} },
  };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => [...tools.keys()], sendMessage: event => notices.push(event) };
  registerApprovalReview(pi, agent, () => {});
  registerExecution(pi, agent, () => {}, { prepare: (request, cwd, agent) => prepareExecution(request, cwd, agent, { platform: "linux", runtime: isolatedRuntime, snapshot: snapshotCommand, backend: sandboxBackend }), execute: async (program, args, options) => { runs.push({ program, args, options }); options.onStdout(Buffer.from("completed")); return ""; }, ...overrides });
  t.after(() => handlers.get("session_shutdown")());
  return { root, cwd, agent, ctx, tools, handlers, reviews, runs, notices, messages,
    call: (input, signal) => tools.get("execution").execute("test", input, signal, undefined, ctx),
    run: (extra = {}, signal) => tools.get("execution").execute("test", { action: "run", command: "printf completed", reason: "test", ...extra }, signal, undefined, ctx),
    manual: async () => { ctx.hasUI = true; try { await commands.get("approvals").handler("manual", ctx); } finally { ctx.hasUI = false; } },
    policy: value => writeFileSync(join(agent, "network-policy.json"), JSON.stringify(value)),
    set verdict(value) { answer = value; }, set review(value) { review = value; },
  };
}
