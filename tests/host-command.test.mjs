import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHostCommand } from "../extensions/tool-policy/host-command.ts";

function fixture(confirms) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-command-")));
  const agent = join(root, "agent"), cwd = join(root, "work");
  for (const dir of [agent, cwd]) mkdirSync(dir, { recursive: true });
  const calls = [], detached = [];
  let tool;
  const execute = async (program, args, options) => { calls.push([program, args, options.cwd]); options.onStdout?.(Buffer.from("hello\n")); if (args[1].includes("false")) throw new Error("exit 1"); return ""; };
  const detach = (command, dir, log) => { detached.push([command, dir, log]); return 4242; };
  registerHostCommand({ registerTool: value => { tool = value; } }, agent, () => {}, execute, detach);
  const ctx = { cwd, hasUI: true, ui: { confirm: async (title, detail) => { assert.ok(confirms.length, "unexpected dialog"); assert.match(detail, /Accès complet/); return confirms.shift(); } } };
  return { run: input => tool.execute("call-1", { cwd, reason: "test", ...input }, undefined, undefined, ctx), ctx, calls, detached, agent, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a refused or headless host command runs nothing", async () => {
  const f = fixture([false]);
  try {
    await assert.rejects(f.run({ command: "echo hi" }), /refused by the user; nothing executed/);
    f.ctx.hasUI = false;
    await assert.rejects(f.run({ command: "echo hi" }), /interactive parent/);
    f.ctx.hasUI = true;
    await assert.rejects(f.run({ command: "echo\u0000hi" }), /Control characters/);
    await assert.rejects(f.run({ command: "echo hi", cwd: join(f.cwd, "missing") }), /ENOENT/);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.detached, []);
  } finally { f.cleanup(); }
});

test("a confirmed command runs verbatim through /bin/sh with its output logged; background detaches", async () => {
  const f = fixture([true, true, true]);
  try {
    const ok = await f.run({ command: "echo hello" });
    assert.deepEqual(f.calls[0], ["/bin/sh", ["-c", "echo hello"], f.cwd]);
    assert.match(ok.content[0].text, /^Exit 0\. Log: .*host-commands.*\nhello$/s);
    const logs = readdirSync(join(f.agent, "host-commands"));
    assert.equal(logs.length, 1);
    assert.equal(readFileSync(join(f.agent, "host-commands", logs[0]), "utf8"), "hello\n");
    const failed = await f.run({ command: "false" });
    assert.equal(failed.isError, true); assert.match(failed.content[0].text, /^Failed: exit 1/);
    const bg = await f.run({ command: "./collector --watch", background: true });
    assert.match(bg.content[0].text, /pid 4242.*detached/);
    assert.equal(f.detached[0][0], "./collector --watch"); assert.equal(f.detached[0][1], f.cwd);
    assert.ok(existsSync(f.detached[0][2]) || f.detached[0][2].includes("host-commands"));
  } finally { f.cleanup(); }
});
