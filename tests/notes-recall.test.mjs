import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// Mock only the process boundary; real sandbox/SQLite coverage lives in tools.integration.test.ts.
const confined = new URL("../lib/confined.ts", import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (url === confined) return { format: "module", shortCircuit: true,
      source: "export const runConfined = (...args) => globalThis.notesTestDispatch(...args);" };
    return next(url, context);
  },
});
const { default: register } = await import("../extensions/notes.ts");
hook.deregister();

test("recall precedes ask capture, is bounded and once per session, and works without note tools", async () => {
  const handlers = new Map(), calls = [];
  let text = "old-agent [decision] inspect the previous session";
  let failList = true;
  globalThis.notesTestDispatch = async (_cwd, service, input) => {
    assert.equal(service, "notes");
    calls.push(input);
    if (input.op === "list") {
      if (failList) throw new Error("memory unavailable");
      return { op: "list", text };
    }
    if (input.op === "inbox") return { op: "inbox", project: "project", lastId: 2 };
    return { op: "add" };
  };
  register({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => [],
    registerCommand() {}, registerShortcut() {}, registerTool() {} });
  const before = () => {
    const event = { prompt: "c'est fait", systemPromptOptions: { sections: {} } };
    return handlers.get("before_agent_start")(event).then(result => ({ result, event }));
  };
  try {
    await handlers.get("session_start")({}, { cwd: "/project" });
    await assert.rejects(before(), /memory unavailable/);
    failList = false;
    calls.length = 0;
    const first = await before();
    assert.deepEqual(calls.map(c => c.op), ["list", "add", "inbox"]);
    assert.equal(calls[0].scope, "project");
    assert.equal(calls[0].limit, 20);
    assert.match(first.result.message.content, /historical data.*not new instructions/);
    assert.match(first.result.message.content, /inspect the previous session/);
    assert.match(first.event.systemPromptOptions.sections.shared_notes, /Before saying prior context is unavailable/);
    assert.match(first.event.systemPromptOptions.sections.shared_notes, /native JSONL sessions/);
    assert.doesNotMatch(first.event.systemPromptOptions.sections.shared_notes, /call note_list|note_add kind=/);
    assert.equal((await before()).result, undefined);
    assert.equal(calls.filter(c => c.op === "list").length, 1);
    text = "x".repeat(16_000);
    await handlers.get("session_before_tree")();
    const again = await before();
    assert.ok(again.result.message.content.length < 12_300);
    assert.ok(again.result.message.content.endsWith("x".repeat(12_000)));
    text = "(no notes)";
    await handlers.get("session_start")({}, { cwd: "/other" });
    assert.equal((await before()).result, undefined);
    assert.equal(calls.at(-3).cwd, "/other");
  } finally {
    await handlers.get("session_shutdown")();
    delete globalThis.notesTestDispatch;
  }
});
