import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../index.ts";
import { getResultOutput, type SingleResult } from "../results.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const result = (overrides = {}): SingleResult => ({
  agent: "worker", agentSource: "user", task: "inspect", exitCode: 0,
  messages: [], stderr: "", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  ...overrides,
});

test("registered subagent renders single, parallel and chain states through the native UI", () => {
  let tool: any;
  const previous = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    register({ on() {}, registerTool(value: any) { tool = value; } } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
  assert.match(tool.renderCall({ chain: [{ agent: "worker", task: "review {previous}" }] }, theme, {}).render(120).join("\n"), /chain \(1 steps\)[\s\S]*review/);
  for (const expanded of [false, true]) {
    for (const [mode, results, expected] of [
      ["single", [result()], /✓ worker/],
      ["single", [result({ exitCode: 7, stopReason: "error", errorMessage: "provider failed" })], /✗ worker[\s\S]*provider failed/],
      ["parallel", [result(), result({ exitCode: -1 })], /1\/2 done, 1 running/],
      ["parallel", [result(), result({ exitCode: 7 })], /1\/2 tasks/],
      ["chain", [result({ step: 1 }), result({ step: 2, exitCode: 7 })], /1\/2 steps/],
    ] as const) {
      const rendered = tool.renderResult({ content: [], details: { mode, results } }, { expanded }, theme, {}).render(120).join("\n");
      assert.match(rendered, expected);
    }
  }
});

test("bounded result preserves complete UTF-8 and artifact pointers on failure", () => {
  const output = getResultOutput(result({ exitCode: 7, stderr: "été".repeat(6000), reportPath: "/report", tracePath: "/trace", resumeId: "owned-run" }));
  assert.ok(Buffer.byteLength(output.split("\n\n")[0]) <= 12 * 1024);
  assert.ok(!output.includes("�"));
  assert.match(output, /Output truncated[\s\S]*Resume: owned-run[\s\S]*Report: \/report[\s\S]*Trace: \/trace/);
  assert.doesNotMatch(getResultOutput(result({ exitCode: -1, reportPath: "/unfinished" })), /Report:/);
});
