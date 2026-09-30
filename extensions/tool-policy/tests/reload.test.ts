import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

test("policy changes take effect in existing handlers; corruption fails closed and recovery needs no reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-live-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const file = join(root, "tool-policy.json");
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    writeFileSync(file, '{"bash":"task"}');
    const handlers = new Map<string, Handler>();
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    const notices: string[] = [];
    let answers = 0;
    let confirm = async () => true;
    const ctx = { cwd: tmpdir(), hasUI: false, ui: {
      notify(message: string) { notices.push(message); },
      async confirm() { return confirm(); },
      async select() { answers++; return "Allow this exact test command for this task"; },
    } } as unknown as ExtensionCommandContext;
    register({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerCommand(_name: string, registered: typeof command) { command = registered; } } as unknown as ExtensionAPI);
    const call = (command = "opaque command") => handlers.get("tool_call")!({ toolName: "bash", input: { command } }, ctx);
    await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, ctx);
    assert.ok(await call());
    writeFileSync(file, '{"bash":"allow"}');
    assert.equal(await call(), undefined);
    await command!.handler("", ctx);
    assert.match(notices.at(-1)!, /live file/);
    assert.match(notices.at(-1)!, /Runtime: Pi .+; PID \d+; extension loaded /);
    assert.ok(notices.at(-1)!.includes(`Working directory: ${ctx.cwd}`));
    assert.match(notices.at(-1)!, /bash: allow/);
    const supervisorCall = (action: string) => handlers.get("tool_call")!({ toolName: "bash_process", input: { action, pgid: 25200 } }, ctx);
    assert.ok(await supervisorCall("peek"), "an unlisted supervisor still falls back to ask");
    writeFileSync(file, readFileSync(new URL("../../../tool-policy.json", import.meta.url)));
    for (const action of ["list", "peek", "kill"]) {
      assert.equal(await supervisorCall(action), undefined, `the checked-in local profile must authorize bash_process ${action}`);
    }
    assert.ok(await handlers.get("tool_call")!({ toolName: "unknown_tool", input: {} }, ctx), "unknown tools still require approval");
    writeFileSync(file, '{"bash":"deny"}');
    assert.ok(await call());
    writeFileSync(file, '{broken');
    assert.ok(await call());
    await command!.handler("", ctx);
    assert.match(notices.at(-1)!, /LOAD FAILED/);
    writeFileSync(file, '{"bash":"allow"}');
    assert.equal(await call(), undefined);
    rmSync(file);
    assert.ok(await call(), "removing the file restores built-in ask, not the cached allow");

    Object.assign(ctx, { hasUI: true });
    writeFileSync(file, '{"bash":"task"}');
    await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, ctx);
    await call("npm run check"); await call("npm run check");
    assert.equal(answers, 1);
    writeFileSync(file, '{"bash":"task","read":"deny"}');
    await call("npm run check");
    assert.equal(answers, 2, "changed policy revokes earlier task grants");

    let answer: (value: boolean) => void = () => {};
    confirm = () => new Promise(resolve => { answer = resolve; });
    writeFileSync(file, '{"bash":"ask"}');
    const pending = call();
    await new Promise(resolve => setImmediate(resolve));
    writeFileSync(file, '{"bash":"deny"}');
    answer(true);
    assert.ok(await pending, "an open approval cannot overrule a newer deny");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("reload command waits for idle without canceling work or using a stale context", async () => {
  let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
  register({ on() {}, registerCommand(_name: string, registered: typeof command) { command = registered; } } as unknown as ExtensionAPI);
  const calls: string[] = [];
  let release = () => {};
  const idle = new Promise<void>(resolve => { release = resolve; });
  const ctx = {
    ui: { notify() { calls.push("notify"); } },
    async waitForIdle() { calls.push("wait"); await idle; },
    async reload() { calls.push("reload"); Object.defineProperty(ctx, "ui", { get() { throw new Error("stale context"); } }); },
  } as unknown as ExtensionCommandContext;
  const pending = command!.handler("reload", ctx);
  assert.deepEqual(calls, ["notify", "wait"]);
  release();
  await pending;
  assert.deepEqual(calls, ["notify", "wait", "reload"]);
});

test("native resource-loader reload and retained handlers both observe the current policy without provider calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-native-reload-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const file = join(root, "tool-policy.json");
    writeFileSync(file, '{"bash":"task"}');
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const original = loader.getExtensions().extensions[0];
    assert.ok(original);
    const notices: string[] = [];
    const ctx = { cwd: root, hasUI: false, ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionCommandContext;
    await original.commands.get("tool-policy")!.handler("", ctx);
    assert.match(notices.at(-1)!, /bash: task/);
    writeFileSync(file, '{"bash":"allow"}');
    await original.commands.get("tool-policy")!.handler("", ctx);
    assert.match(notices.at(-1)!, /bash: allow/, "even a retained extension handler must refresh");
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const reloaded = loader.getExtensions().extensions[0];
    assert.notEqual(reloaded, original);
    await reloaded.commands.get("tool-policy")!.handler("", ctx);
    assert.match(notices.at(-1)!, /bash: allow/);
    const result = await reloaded.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "opaque command" } }, ctx);
    assert.equal(result, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
