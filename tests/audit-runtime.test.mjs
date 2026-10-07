import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerAudit } from "../extensions/audit/index.ts";
import { McpApprovals, APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { auditReport } from "../lib/audit-report.ts";

test("installed Pi SDK emits observable blocked calls, approval dialogs and execution failures", { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-audit-runtime-")));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  let calls = 0, executed = 0;
  runtime.registerProvider("audit-offline-fixture", {
    api: "audit-offline-fixture", baseUrl: "http://127.0.0.1:1", apiKey: "fixture",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() {
      calls++;
      assert.ok(calls <= 2, "No automatic retries or external provider calls");
      const content = calls === 1 ? [
        { type: "toolCall", id: "blocked-call", name: "blocked_fixture", arguments: {} },
        { type: "toolCall", id: "approved-call", name: "approved_fixture", arguments: {} },
      ] : [{ type: "text", text: "The operation failed after approval." }];
      const message = { role: "assistant", content, api: "audit-offline-fixture", provider: "audit-offline-fixture", model: "fixture", timestamp: Date.now(),
        stopReason: calls === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const approvals = new McpApprovals(agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "audit-fixture", factory: pi => registerAudit(pi, agentDir) },
      { name: "tools-fixture", factory(pi) {
        pi.on("tool_call", event => event.toolName === "blocked_fixture" ? { block: true, reason: "Unsupported executor denied before approval" } : undefined);
        pi.registerTool({ name: "blocked_fixture", label: "blocked", description: "fixture", parameters: Type.Object({}), async execute() { throw new Error("BLOCKED_EXECUTOR_MUST_NOT_RUN"); } });
        pi.registerTool({ name: "approved_fixture", label: "approved", description: "fixture", parameters: Type.Object({}), async execute(id, _input, signal, _update, ctx) {
          await approvals.authorize(ctx, { resource: "runtime-fixture", operation: "inspect", identity: "fixture", toolCallId: id,
            title: "Approve fixture?", detail: "Inspect only", remember: false, revalidate() {} }, signal);
          executed++; throw new Error("Fixture connection refused");
        } });
      } },
    ],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("audit-offline-fixture", "fixture"),
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["blocked_fixture", "approved_fixture"] });
  const errors = [];
  try {
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error), uiContext: {
      select: async () => APPROVAL_CHOICES[1], confirm: async () => false, input: async () => undefined,
      editor: async () => undefined, custom: async () => undefined, notify() {},
    } });
    await session.prompt("Inspect the fixture");
    assert.equal(calls, 2); assert.equal(executed, 1); assert.deepEqual(errors, []);
    const report = auditReport(agentDir, { cwd, events: 100 });
    assert.equal(report.summary.requests, 1);
    assert.deepEqual(report.executions.map(row => ({ ...row })), [{ outcome: "failed", count: 1 }]);
    const blocked = report.timeline.find(row => row.kind === "tool.end" && row.tool_call_id === "blocked-call");
    assert.equal(blocked.payload.isError, true);
    assert.match(JSON.stringify(blocked.payload.result), /Unsupported executor denied/);
    const dialog = report.timeline.find(row => row.kind === "dialog.open");
    assert.equal(dialog.tool_call_id, "approved-call"); assert.ok(dialog.request_id);
    assert.ok(report.timeline.some(row => row.kind === "dialog.answer" && row.dialog_id === dialog.dialog_id));
    assert.ok(report.timeline.some(row => row.kind === "message.end" && row.payload.role === "assistant"));
  } finally { session.dispose(); }
});
