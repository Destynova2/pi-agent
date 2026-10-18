import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_QUESTIONS_PER_SESSION, registerAskUser } from "../extensions/tool-policy/ask-user.ts";

function fixture() {
  const handlers = new Map(), dialogs = [];
  let tool, answer = "B", yes = true;
  registerAskUser({ on: (name, fn) => handlers.set(name, fn), registerTool: value => { tool = value; } }, () => {});
  const ctx = { cwd: "/p", hasUI: true, ui: {
    select: async (prompt, options) => { dialogs.push(["select", prompt, options]); return answer; },
    confirm: async (title, detail) => { dialogs.push(["confirm", title, detail]); return yes; },
  } };
  return { ask: input => tool.execute("1", input, undefined, undefined, ctx), ctx, dialogs, handlers, setAnswer: v => { answer = v; }, setYes: v => { yes = v; } };
}

test("ask_user asks one bounded question and returns the answer", async () => {
  const f = fixture();
  assert.equal((await f.ask({ question: "Accept chromiumoxide?", detail: "40 transitive crates", options: ["A", "B"] })).content[0].text, "B");
  assert.deepEqual(f.dialogs[0], ["select", "Accept chromiumoxide?\n40 transitive crates", ["A", "B"]]);
  assert.equal((await f.ask({ question: "Continue?" })).content[0].text, "yes");
  f.setYes(false);
  assert.equal((await f.ask({ question: "Continue?" })).content[0].text, "no");
  f.setAnswer(undefined);
  assert.equal((await f.ask({ question: "Pick", options: ["x", "y"] })).content[0].text, "cancelled");
  await assert.rejects(f.ask({ question: "Pick", options: ["x", "x"] }), /distinct/);
  assert.equal((await f.ask({ question: "ctl\u0007chars", options: ["a\u001bb", "c"] })).content[0].text, "cancelled");
  assert.deepEqual(f.dialogs.at(-1)[2], ["a b", "c"], "control characters are stripped");
});

test("ask_user is parent-only and budgeted per session", async () => {
  const f = fixture();
  f.ctx.hasUI = false;
  await assert.rejects(f.ask({ question: "q" }), /interactive parent/);
  f.ctx.hasUI = true;
  process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.ask({ question: "q" }), /interactive parent/); } finally { delete process.env.PI_SUBAGENT_CHILD; }
  for (let i = 0; i < MAX_QUESTIONS_PER_SESSION; i++) await f.ask({ question: "q" });
  await assert.rejects(f.ask({ question: "q" }), /budget used/);
  f.handlers.get("session_start")();
  await f.ask({ question: "q" });
});
