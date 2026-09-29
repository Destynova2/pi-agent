import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

test("native follow-up batching keeps every queued message in order with one continuation", async () => {
  const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8"));
  assert.equal(settings.followUpMode, "all");
  const callsByMode: Record<string, number> = {};
  for (const mode of ["one-at-a-time", "all"] as const) {
    let calls = 0;
    const model = { id: "offline", name: "Offline", provider: "fixture", api: "openai-completions", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
    const agent = new Agent({
      initialState: { model, thinkingLevel: "off" }, followUpMode: mode,
      streamFn: () => {
        if (++calls === 1) {
          for (let i = 0; i < 10; i++) agent.followUp({ role: "user", content: [{ type: "text", text: `completion-${i}` }], timestamp: i });
        }
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "ack" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
        queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
        return stream;
      },
    });
    await agent.prompt("start");
    assert.equal(agent.state.errorMessage, undefined);
    const users = agent.state.messages.filter(m => m.role === "user").map((m: any) => m.content.map((c: any) => c.text).join(""));
    assert.deepEqual(users, ["start", ...Array.from({ length: 10 }, (_, i) => `completion-${i}`)]);
    callsByMode[mode] = calls;
  }
  assert.deepEqual(callsByMode, { "one-at-a-time": 11, all: 2 });
});
