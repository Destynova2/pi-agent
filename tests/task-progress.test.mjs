import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../extensions/task-progress/index.ts";
import { STRICT_TOOLS } from "../extensions/tool-policy/index.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture() {
  let entries = [], tool;
  const events = new Map(), commands = new Map(), sent = [];
  const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => entries }, ui: { notify: text => sent.push(text) } };
  const load = () => register({
    registerTool: value => { tool = value; }, on: (name, fn) => events.set(name, fn),
    registerCommand: (name, fn) => commands.set(name, fn), getActiveTools: () => ["task_checkpoint"],
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage() { assert.fail("must not start new model turns"); }, sendUserMessage() { assert.fail("must not start new model turns"); },
  });
  load();
  return { events, commands, ctx, sent, load, get entries() { return entries; }, set entries(value) { entries = value; },
    call: (input, signal) => tool.execute("id", input, signal, undefined, ctx),
    context: messages => events.get("context")({ messages }, ctx).messages };
}
const first = { id: "implementation", requirement: "Implement the requested behavior; verify regression", status: "pending" };
const second = { id: "activation", requirement: "Back up, install and verify a new Pi process", status: "pending" };

test("checkpoint preserves omitted outcomes and requires evidence without approving capabilities", async () => {
  const f = fixture();
  assert.ok(STRICT_TOOLS.has("task_checkpoint"));
  assert.equal(CONFINED_TOOLS.has("task_checkpoint"), false, "parent owns the full request");
  await f.call({ action: "start", task: "Complete delivery", items: [first, second] });
  await assert.rejects(f.call({ action: "update", items: [{ ...first, status: "done" }] }), /evidence/);
  await f.call({ action: "update", items: [{ ...first, status: "done", evidence: "regression test exits 0" }] });
  assert.deepEqual(f.entries.at(-1).data.items.map(item => item.status), ["done", "pending"]);
  await assert.rejects(f.call({ action: "update", items: [{ ...second, requirement: "Only edit source" }] }), /original requirement/);
  await assert.rejects(f.call({ action: "start", task: "Forget remaining work", items: [first] }), /Unfinished/);
  await f.call({ action: "update", items: [{ ...second, status: "blocked", evidence: "GPU backend unavailable; needs supported capability" }] });
  const messages = f.context([]);
  assert.match(messages[0].content, /GPU backend unavailable/);
  assert.match(messages[0].content, /not new authorization/);
  await f.commands.get("task-status").handler("", f.ctx);
  assert.match(f.sent[0], /blocked.*activation/);
  assert.equal(f.events.has("agent_end"), false);
});

test("restart, compaction and branch navigation recover only the active branch without duplicating context", async () => {
  const f = fixture();
  await f.call({ action: "start", task: "Full request", items: [first, second] });
  const previous = structuredClone(f.entries);
  await f.call({ action: "update", items: [{ ...second, status: "done", evidence: "native activation probe exits 0" }] });
  f.load();
  assert.match(f.context([])[0].content, /native activation probe/);
  assert.equal(f.context(f.context([])).length, 1);
  f.entries = previous;
  assert.doesNotMatch(f.context([])[0].content, /native activation probe/);
  f.entries.push({ type: "compaction", summary: "omits installation" });
  assert.match(f.context([])[0].content, /Back up, install/);
  f.entries = [];
  assert.deepEqual(f.context([]), []);
});

test("aborted or malformed updates leave state untouched and explicit user replacements remain recorded", async () => {
  const f = fixture();
  await assert.rejects(f.call({ action: "start", task: "task", items: [first] }, AbortSignal.abort()));
  assert.equal(f.entries.length, 0);
  await assert.rejects(f.call({ action: "start", task: "task", items: [first, first] }), /Unique/);
  await f.call({ action: "start", task: "task", items: [first] });
  await f.call({ action: "start", task: "New task", supersedes: "User explicitly canceled the previous request", items: [second] });
  assert.equal(f.entries.length, 2);
  assert.match(f.context([])[0].content, /explicitly canceled/);
  f.entries.at(-1).data.items[0].status = "invented";
  assert.throws(() => f.context([]), /Invalid/);
});

test("native widget follows the current branch, concurrent delegations and session cleanup", async () => {
  const f = fixture(), widgets = new Map();
  f.ctx.mode = "tui";
  f.ctx.ui.setWidget = (key, content) => widgets.set(key, content);
  await f.events.get("session_start")({}, f.ctx);
  assert.equal(widgets.get("task-progress"), undefined);
  await f.call({ action: "start", task: "task", items: [first, second] });
  assert.match(widgets.get("task-progress")[0], /0\/2/);
  await f.call({ action: "update", items: [{ ...first, status: "done", evidence: "test passed" }] });
  assert.match(widgets.get("task-progress")[0], /1\/2/);
  for (const toolCallId of ["a", "b"]) f.events.get("tool_execution_start")({ toolName: "subagent", toolCallId }, f.ctx);
  assert.match(widgets.get("task-progress")[1], /2/);
  f.events.get("tool_execution_end")({ toolCallId: "a" }, f.ctx);
  assert.match(widgets.get("task-progress")[1], /1/);
  f.entries = [];
  f.events.get("session_tree")({}, f.ctx);
  assert.deepEqual(widgets.get("task-progress"), ["Delegations running: 1"]);
  f.events.get("session_shutdown")({}, f.ctx);
  assert.equal(widgets.get("task-progress"), undefined);
  f.ctx.mode = "rpc";
  f.ctx.ui.setWidget = () => assert.fail("RPC must not render terminal components");
  await f.call({ action: "start", task: "headless", items: [first] });
});
