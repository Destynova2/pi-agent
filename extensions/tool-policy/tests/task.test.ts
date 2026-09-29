import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { taskDecision, taskPathReason } from "../task.ts";
import { loadToolPolicy, toolDecision } from "../core.ts";

test("task rules recognize only scoped routine operations; scripts and shell tricks ask", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-rules-")));
  try {
    writeFileSync(join(root, "source.ts"), "example");
    mkdirSync(join(root, "dir"));
    for (const command of ["pwd", "ls -lah .", "ls 'dir'", 'ls "dir"', "wc -l source.ts", "head -n 12 source.ts", "tail -n 5 source.ts", "find . -maxdepth 3 -type f", "rg --files .", "rg -n example source.ts"]) {
      assert.equal(taskDecision("bash", { command }, root).action, "allow", command);
    }
    for (const command of ["node -e 'process.exit()'", "rm -rf dir", "git push", "npm publish", "terraform apply", "curl example.org", "sudo ls", "ls; rm -rf dir", "ls && rm -rf dir", "ls | sh", "ls > output", "ls $(pwd)", "ls `pwd`", "ls\nrm x", "ls &", "ls *", "ls ${HOME}", "find . -exec sh cmd", "find . -delete", "find -L .", "rg --pre sh x source.ts", "rg x .", "rg --files ..", "ls ../", "ls /", "ls .env", "head -n 1 .env", "tail -f source.ts", "ls --color=always", "ls 'dir", "l's'", "PATH=. ls", "env ls", "./ls", "node --test ../outside.ts"]) {
      assert.equal(taskDecision("bash", { command }, root).action, "ask", command);
    }
    for (const command of ["npm run check", "npm run test", "node --test source.ts"]) assert.equal(taskDecision("bash", { command }, root).action, "test");
    for (const name of ["read", "write", "edit", "grep"]) assert.equal(taskDecision(name, { path: "source.ts" }, root).action, "allow");
    assert.equal(taskDecision("grep", { pattern: "token" }, root).action, "ask");
    for (const name of ["ls", "find"]) assert.equal(taskDecision(name, {}, root).action, "allow");
    assert.equal(taskDecision("unknown", {}, root).action, "ask");
    for (const path of ["../other", ".env", ".env.local", ".ssh/key", ".git/config", ".pi/extensions/foo.ts", "auth.json", "credentials.json", "private.pem"]) assert.ok(taskPathReason(path, root), path);
    symlinkSync(tmpdir(), join(root, "outside"));
    assert.ok(taskPathReason("outside/file", root));
    symlinkSync(join(root, ".env"), join(root, "dangling"));
    assert.ok(taskPathReason("dangling", root));
    linkSync(join(root, "source.ts"), join(root, "hardlink"));
    assert.ok(taskPathReason("hardlink", root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

function harness(root: string, choice: () => Promise<string | undefined>, hasUI = true) {
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  const prompts: string[] = [];
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    extension({
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerCommand() {},
    } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const ctx = { cwd: join(root, "work"), hasUI, ui: {
    async select(title: string) { prompts.push(title); return choice(); },
    async confirm(title: string) { prompts.push(title); return false; },
    notify(message: string) { notices.push(message); },
  } } as unknown as ExtensionContext;
  const emit = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!(event, ctx);
  const start = () => emit("before_agent_start", { systemPromptOptions: { sections: {} } });
  const call = (command: string) => emit("tool_call", { toolName: "bash", input: { command } });
  return { ctx, emit, start, call, prompts, notices };
}

test("exact test grants are explicit, serialized, task-bound, and never inherited headlessly", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-lifecycle-"));
  try {
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "tool-policy.json"), '{"bash":"task","*":"ask"}');
    assert.equal(toolDecision(loadToolPolicy(root), "bash"), "task");
    const h = harness(root, async () => "Allow this exact test command for this task");
    await h.start();
    assert.equal(await h.call("pwd"), undefined);
    assert.equal(h.prompts.length, 0);
    const calls = await Promise.all([h.call("npm run check"), h.call("npm run check")]);
    assert.deepEqual(calls, [undefined, undefined]);
    assert.equal(h.prompts.length, 1);
    await h.call("npm run test");
    assert.equal(h.prompts.length, 2);
    assert.ok(await h.call("git push"));
    assert.ok(await h.call("git push"));
    assert.equal(h.prompts.length, 4);
    await h.emit("agent_settled");
    assert.match(h.notices[0], /2 automatically authorized, 2 explicitly authorized, 2 blocked/);
    await h.start();
    await h.call("npm run check");
    assert.equal(h.prompts.length, 5);
    await h.start();
    await h.call("npm run check");
    assert.equal(h.prompts.length, 6);
    h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
    assert.throws(() => h.emit("agent_settled"), /UI unavailable/);
    assert.ok(await h.call("npm run check")); // No active task/grant after the notification failed.
    const headless = harness(root, async () => { throw new Error("must not prompt"); }, false);
    await headless.start();
    assert.equal(await headless.call("pwd"), undefined);
    assert.ok(await headless.call("npm run check"));
    assert.equal(headless.prompts.length, 0);
    const once = harness(root, async () => "Allow once");
    await once.start();
    await once.call("npm run check"); await once.call("npm run check");
    assert.equal(once.prompts.length, 2);
    const deny = harness(root, async () => undefined);
    await deny.start();
    assert.ok(await deny.call("npm run check"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("late approval after task change or abort cannot authorize execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-race-"));
  try {
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "tool-policy.json"), '{"bash":"task"}');
    for (const abort of [false, true]) {
      let answer: (choice: string) => void = () => {};
      const h = harness(root, () => new Promise(resolve => { answer = resolve; }));
      const controller = new AbortController();
      Object.defineProperty(h.ctx, "signal", { value: controller.signal });
      await h.start();
      const pending = h.call("npm run check");
      await new Promise(resolve => setImmediate(resolve));
      if (abort) controller.abort(); else await h.start();
      answer("Allow this exact test command for this task");
      assert.ok(await pending);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
