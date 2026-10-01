// Lifecycle regression tests for extensions/ci-watch/index.ts, using the file's own narrow
// injection seam (the optional `ciImpl` parameter on the default export) instead of the real
// jailed worker: fast, offline, and able to script races (hangs, rejects, aborts) that the real
// `gh`/`glab` fixtures in tests/ci-watch.test.ts cannot.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register, { type CiFn } from "../extensions/ci-watch/index.ts";
import type { CiResult, Snapshot } from "../extensions/ci-watch/worker.ts";

type TestContext = ReturnType<typeof ctx>;
type ToolDef = { execute: (id: string, params: { action: string; pr?: number; intervalSeconds?: number; timeoutMinutes?: number }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: TestContext) => Promise<{ content: { type: string; text: string }[] }> };
type CommandHandler = (args: string, ctx: TestContext) => Promise<void>;
type EventHandler = () => unknown;

/** Minimal fake pi: captures the tool/command/event handlers the extension registers. */
function fakePi() {
  const events = new Map<string, EventHandler[]>();
  let tool: ToolDef | undefined;
  let command: CommandHandler | undefined;
  const sent: unknown[] = [];
  const api = {
    on: (name: string, handler: EventHandler) => { (events.get(name) ?? events.set(name, []).get(name))!.push(handler); return () => undefined; },
    registerTool: (def: ToolDef) => { tool = def; },
    registerCommand: (_name: string, def: { handler: CommandHandler }) => { command = def.handler; },
    sendMessage: async (message: unknown) => { sent.push(message); },
  } as unknown as ExtensionAPI;
  const fire = async (name: string) => { for (const h of events.get(name) ?? []) await h(); };
  return { api, get tool() { return tool!; }, get command() { return command!; }, fire, sent };
}

const ctx = (overrides: Partial<{ cwd: string; hasUI: boolean }> = {}) => ({
  cwd: overrides.cwd ?? "/repo",
  hasUI: overrides.hasUI ?? false,
  ui: { notify: () => undefined, setStatus: () => undefined },
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  provider: "github", number: 1, title: "t", url: "u", state: "open", review: "none",
  conflict: false, head: "a", overall: "pending", checks: [], ...over,
});

test("session boundary cancels an in-flight start before any watch exists", async () => {
  const calls: string[] = [];
  const ci: CiFn = (_cwd, input, signal) => {
    calls.push(input.op);
    if (input.op === "detect") {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    throw new Error(`unexpected op ${input.op}`);
  };
  const h = fakePi();
  register(h.api, ci);
  const tool = h.tool;
  const fire = h.fire;
  const started = tool.execute("1", { action: "start" }, undefined, undefined, ctx());
  // Session resets (e.g. session_start) while detectProvider() is still in flight: stopAll must
  // reach this ephemeral op too, not just the (nonexistent yet) watches map.
  await fire("session_start");
  await assert.rejects(started);
  assert.deepEqual(calls, ["detect"]);
});

test("concurrent start() for different PRs never shares the other's result", async () => {
  const ci: CiFn = async (_cwd, input) => {
    switch (input.op) {
      case "detect": return { op: "detect", provider: "github" } satisfies CiResult;
      case "snapshot": return { op: "snapshot", snapshot: snap({ number: input.number, overall: "pending" }) } satisfies CiResult;
      default: throw new Error(`unexpected op ${input.op}`);
    }
  };
  const h = fakePi();
  register(h.api, ci);
  const tool = h.tool;
  const [a, b] = await Promise.all([
    tool.execute("1", { action: "start", pr: 1 }, undefined, undefined, ctx()),
    tool.execute("2", { action: "start", pr: 2 }, undefined, undefined, ctx()),
  ]);
  assert.match(a.content[0].text, /#1/);
  assert.match(b.content[0].text, /#2/);
});

test("tool call with an already-aborted signal must not spawn", async () => {
  let calls = 0;
  const ci: CiFn = async () => { calls++; throw new Error("should never run"); };
  const h = fakePi();
  register(h.api, ci);
  const tool = h.tool;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute("1", { action: "start" }, controller.signal, undefined, ctx()));
  await assert.rejects(tool.execute("1", { action: "status" }, controller.signal, undefined, ctx()));
  assert.equal(calls, 0);
});

test("tick: a failed log fetch after a red snapshot does not crash the detached timer, and the deadline is still checked on repeated errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ops: string[] = [];
  let tickCount = 0;
  const ci: CiFn = async (_cwd, input) => {
    ops.push(input.op);
    switch (input.op) {
      case "detect": return { op: "detect", provider: "github" };
      case "current": return { op: "current", number: 7 };
      case "snapshot": {
        tickCount++;
        // First fetch (during start()): pending, open -- no transition, nothing to wake on.
        if (tickCount === 1) return { op: "snapshot", snapshot: snap({ number: 7, overall: "pending" }) };
        // Every later fetch: a red check, every time -- this would hang forever pre-fix because
        // the deadline was never re-checked on the error branch.
        return { op: "snapshot", snapshot: snap({ number: 7, overall: "failure", head: `h${tickCount}` }) };
      }
      case "log":
        throw new Error("log fetch failed");
      default:
        throw new Error("unexpected CI operation");
    }
  };
  const h = fakePi();
  register(h.api, ci);
  const tool = h.tool;
  const result = await tool.execute("1", { action: "start", intervalSeconds: 15, timeoutMinutes: 1 }, undefined, undefined, ctx());
  assert.match(result.content[0].text, /Watching #7/);

  // The timer callback's own async chain resolves over real microtasks (the fake ci() returns
  // real Promises); `tick()` is sync, so flush a few turns of the microtask queue after it.
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  // First scheduled tick (t=15s, well before the 1-minute deadline): snapshot goes red, the log
  // fetch throws. Pre-fix this was an unhandled rejection; now it must land in tick's catch and
  // simply reschedule (not stop, not crash).
  t.mock.timers.tick(15_000);
  await flush();
  assert.ok(ops.includes("log"), "log op must have been attempted");
  const statusAfterFirstError = await tool.execute("2", { action: "list" }, undefined, undefined, ctx());
  assert.match(statusAfterFirstError.content[0].text, /#7/, "watch must still be active after one failing tick");

  // Advance well past the 1-minute deadline across more failing ticks: the error branch must
  // check the deadline just like the success branch, and eventually stop the watch.
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(15_000);
    await flush();
  }
  const statusAfterDeadline = await tool.execute("3", { action: "list" }, undefined, undefined, ctx());
  assert.equal(statusAfterDeadline.content[0].text, "No active watch.");
});

test("stop cancels a matching in-flight start before it ever produces a watch", async () => {
  const ci: CiFn = (_cwd, input, signal) => {
    if (input.op === "detect") {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    throw new Error(`unexpected op ${input.op}`);
  };
  const h = fakePi();
  register(h.api, ci);
  const tool = h.tool;
  const started = tool.execute("1", { action: "start", pr: 9 }, undefined, undefined, ctx());
  const stopped = await tool.execute("2", { action: "stop", pr: 9 }, undefined, undefined, ctx());
  assert.equal(stopped.content[0].text, "No matching watch.");
  await assert.rejects(started);
});
