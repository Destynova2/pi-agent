import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHarnessUpdate } from "../extensions/tool-policy/harness-update.ts";

// Every host process is injected: the test proves what runs, in which order, and what never runs.
function fixture({ confirms, trees = ["tree-a", "tree-a", "tree-a"], verifyFails = false }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-update-")));
  const agent = join(root, "agent"), source = join(root, "source"), cwd = join(root, "project");
  for (const dir of [agent, join(source, "scripts"), cwd]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"pi-agent-config"}');
  writeFileSync(join(source, "scripts/install.mjs"), "");
  const calls = [], entries = [], handlers = new Map();
  let tool;
  const execute = async (program, args) => {
    calls.push([program, ...args]);
    if (program === "git") return args.includes("write-tree") ? trees.shift() : args.includes("rev-parse") ? "abc1234" : "";
    if (program === "npm") { if (verifyFails) throw new Error("exit 1"); return ""; }
    return "install: done";
  };
  registerHarnessUpdate({
    on: (name, fn) => handlers.set(name, fn), registerTool: value => { tool = value; },
    getActiveTools: () => ["harness_update"], appendEntry: (type, data) => entries.push({ type, data }),
  }, agent, () => {}, execute);
  const ctx = { cwd, hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { assert.ok(confirms.length, "unexpected dialog"); return confirms.shift(); } } };
  const run = (input = { source, reason: "test" }) => tool.execute("call-1", input, undefined, undefined, ctx);
  const commands = () => calls.map(call => call[0] === "git" ? `git ${call.at(-1)}` : call[0] === "npm" ? "npm verify" : "install");
  return { run, commands, entries, source, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("nothing runs in the source before the human agrees, and a refusal runs nothing", async () => {
  const f = fixture({ confirms: [false] });
  try {
    await assert.rejects(f.run({ source: join(f.source, "scripts"), reason: "x" }), /not a pi-agent-config source/);
    await assert.rejects(f.run(), /refused by the user; nothing executed/);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test("a red verify or a refused install leaves the runtime untouched", async () => {
  const red = fixture({ confirms: [true], verifyFails: true });
  try {
    await assert.rejects(red.run(), /verify failed/);
    assert.deepEqual(red.commands(), ["git HEAD", "git --porcelain", "git .", "git write-tree", "npm verify"]);
  } finally { red.cleanup(); }
  const refused = fixture({ confirms: [true, false] });
  try {
    await assert.rejects(refused.run(), /Install refused/);
    assert.ok(!refused.commands().includes("install"));
    assert.deepEqual(refused.entries, []);
  } finally { refused.cleanup(); }
});

test("the install is bound to the tree verify saw", async () => {
  const changed = fixture({ confirms: [true, true], trees: ["tree-a", "tree-b"] });
  try {
    await assert.rejects(changed.run(), /source changed since verify/);
    assert.ok(!changed.commands().includes("install"));
  } finally { changed.cleanup(); }
  const ok = fixture({ confirms: [true, true] });
  try {
    const result = await ok.run();
    assert.match(result.content[0].text, /Installed .* Restart Pi/);
    // verify, then the digest is checked before and after the second dialog, then the install.
    assert.deepEqual(ok.commands().slice(4), ["npm verify", "git .", "git write-tree", "git .", "git write-tree", "install"]);
    assert.equal(ok.entries[0].data.tree, "tree-a");
  } finally { ok.cleanup(); }
});

test("one update at a time, and only from the interactive parent", async () => {
  const f = fixture({ confirms: [false] });
  try {
    const first = f.run();
    await assert.rejects(f.run(), /already running/);
    await assert.rejects(first, /refused/);
  } finally { f.cleanup(); }
  const child = fixture({ confirms: [] });
  try {
    process.env.PI_SUBAGENT_CHILD = "1";
    await assert.rejects(child.run(), /interactive parent/);
    assert.deepEqual(child.calls, []);
  } finally { delete process.env.PI_SUBAGENT_CHILD; child.cleanup(); }
});
