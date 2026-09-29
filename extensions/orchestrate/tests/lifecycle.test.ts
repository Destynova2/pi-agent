import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

type Handler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("orchestrate command: forwards instructions without simulating the LLM", async () => {
  let handler: Handler | undefined;
  const messages: string[] = [];
  const notifications: string[] = [];
  register({
    registerCommand: (_name: string, definition: { handler: Handler }) => { handler = definition.handler; },
    on: () => undefined,
    sendUserMessage: (message: string) => { messages.push(message); },
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  const ctx = { ui: { notify: (text: string) => { notifications.push(text); } } } as unknown as Parameters<Handler>[1];

  await handler("fix the prompt", ctx);
  assert.equal(messages.length, 1);
  const prompt = messages[0];
  assert.match(prompt, /read-only before guessing/s);
  assert.match(prompt, /substantial ambiguity of intent/);
  assert.match(prompt, /openai-codex\/gpt-6-astra.*anthropic\/claude-fable-5-1/s);
  assert.match(prompt, /agreement is not proof/);
  assert.match(prompt, /forbidden as worker.*even if the chef is Fable/s);
  assert.match(prompt, /do not downgrade an M\/L task to S/);
  assert.match(prompt, /is neither a snapshot nor a backup/);
  assert.match(prompt, /never use \`git checkout\` as a rollback/);

  await handler("status", ctx);
  await handler("cancel", ctx);
  assert.ok(notifications.some((text) => text.includes("No local gate in progress. Local gates status only")));
  assert.ok(notifications.includes("No gate in progress."));
});

for (const method of ["cancel", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_start"]) {
  test(`orchestrate command: concurrent exclusion and ${method}`, async () => {
    // Isolated fixture: PI_GATES_BIN points the runtime to a test binary, without depending
    // on HOME or a real install path (see extensions/orchestrate/index.ts).
    const home = await mkdtemp(join(tmpdir(), "pi-orchestrate-lifecycle-"));
    const oldGatesBin = process.env.PI_GATES_BIN;
    let handler: Handler | undefined;
    const events = new Map<string, () => Promise<void>>();
    const notifications: string[] = [];
    const ready = join(home, "ready");
    const marker = join(home, "survived");
    const gatesBin = join(home, "pi-prek-fixture");
    let job: Promise<void> | undefined;
    let complete = false;
    try {
      const child = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),2000);`;
      const parent = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); child.on('error',error=>{console.error(error);process.exit(1)}); child.on('exit',code=>{console.error('fixture child exited '+code);process.exit(code??1)}); setInterval(()=>{},1000);`;
      await writeFile(gatesBin, `#!${process.execPath}\n${parent}\n`, { mode: 0o700 });
      process.env.PI_GATES_BIN = gatesBin;
      register({
        registerCommand: (_name: string, definition: { handler: Handler }) => { handler = definition.handler; },
        on: (event: string, callback: () => Promise<void>) => { events.set(event, callback); },
      } as unknown as ExtensionAPI);
      assert.ok(handler);
      const ctx = { cwd: home, ui: {
        setStatus: () => undefined,
        notify: (text: string) => { notifications.push(text); },
      } } as unknown as Parameters<Handler>[1];
      job = handler("gates full", ctx);
      void job.then(() => { complete = true; });
      for (let i = 0; i < 250 && !complete; i++) {
        try { await access(ready); break; } catch { await delay(20); }
      }
      assert.equal(await readFile(ready, "utf8").catch(() => "missing"), "ready", notifications.join("\n"));
      await handler("gates full", ctx);
      assert.ok(notifications.some((text) => text.includes("already in progress")));
      await handler("status", ctx);
      assert.ok(notifications.some((text) => text.includes("Local gates in progress.")));
      if (method === "cancel") {
        await handler("cancel", ctx);
        assert.ok(notifications.some((text) => text.includes("Canceling gates")));
      } else {
        const transition = events.get(method);
        assert.ok(transition);
        await transition();
      }
      await job;
      await delay(2100);
      assert.ok(notifications.some((text) => text.includes("BLOCKED")));
      await assert.rejects(access(marker));
      await handler("cancel", ctx);
      assert.ok(notifications.includes("No gate in progress."));
    } finally {
      await events.get("session_shutdown")?.();
      await job;
      process.env.PI_GATES_BIN = oldGatesBin;
      await rm(home, { recursive: true, force: true });
    }
  });
}
