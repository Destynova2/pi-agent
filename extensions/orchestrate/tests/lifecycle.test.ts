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
  const deliveries: unknown[] = [];
  const notifications: string[] = [];
  register({
    registerCommand: (_name: string, definition: { handler: Handler }) => { handler = definition.handler; },
    on: () => undefined,
    sendUserMessage: (message: string, options: unknown) => { messages.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  const ctx = { ui: { notify: (text: string) => { notifications.push(text); } } } as unknown as Parameters<Handler>[1];

  await handler("fix the prompt", ctx);
  assert.equal(messages.length, 1);
  const prompt = messages[0];
  assert.deepEqual(deliveries, [{ deliverAs: "followUp" }]);
  assert.ok(prompt.endsWith("Request:\nfix the prompt"));
  assert.ok(prompt.length < 3000, "Keep the orchestration prefix concise");
  assert.doesNotMatch(prompt, /KERNEL|pre-mortem|openai-codex\/|anthropic\//);
  assert.match(prompt, /not a workflow engine or a global session tracker/);
  assert.match(prompt, /Read the relevant code.*before editing/);
  assert.match(prompt, /ask the user directly before acting/);
  assert.match(prompt, /For audits, stay read-only/);
  assert.match(prompt, /complexity and risk, not file count/);
  assert.match(prompt, /low-risk task directly.*without.*mandatory delegation/);
  assert.match(prompt, /independent reviewer for risky changes/);
  assert.match(prompt, /children do not inherit this conversation/);
  assert.match(prompt, /first usable, tested slice before broad write delegation/);
  assert.match(prompt, /Fix contracts before parallel work; use chain for dependencies/);
  assert.match(prompt, /Set timeoutSeconds/);
  assert.match(prompt, /without a second correction round by default/);
  assert.match(prompt, /checkpoint in shared notes/);
  assert.match(prompt, /Batch independent investigations and read-only checks/);
  assert.match(prompt, /After compaction, resume the checkpoint/);
  assert.match(prompt, /inspect the current worktree; notes are hints, not proof/);
  assert.match(prompt, /verify the combined change and map each requirement to evidence/);
  assert.match(prompt, /configured agent models; verify availability/);
  assert.match(prompt, /first slice is a checkpoint, not the finish line/);
  assert.match(prompt, /If optional delegation is unavailable, work directly/);
  assert.match(prompt, /If required review is unavailable, ask about that gate and keep it open/);
  assert.match(prompt, /Never present solo work as independently reviewed/);
  assert.match(prompt, /check other agents' claims and protect preexisting changes/);
  assert.match(prompt, /git\/jj reference in a note is not a backup/);
  assert.match(prompt, /wait for completion, preserve exit codes/);
  assert.match(prompt, /No commit, push, merge or deployment without explicit user authorization/);
  assert.match(prompt, /review verdict does not authorize deployment/);
  assert.match(prompt, /pending CI as pending/);

  await handler("status", ctx);
  await handler("cancel", ctx);
  assert.ok(notifications.some((text) => text.includes("No local gate in progress. Local gates status only")));
  assert.ok(notifications.includes("No gate in progress."));
});

test("completion guidance covers ordinary, explicit and child turns without delegation or automatic continuations", async () => {
  type PromptEvent = { prompt: string; systemPromptOptions: { sections: Record<string, string> } };
  const events = new Map<string, (event: PromptEvent) => void>();
  let command: Handler | undefined;
  const sent: string[] = [];
  let tools = ["subagent"];
  const oldChild = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    register({
      on: (name: string, handler: (event: PromptEvent) => void) => events.set(name, handler),
      getActiveTools: () => tools,
      registerCommand: (_name: string, definition: { handler: Handler }) => { command = definition.handler; },
      sendUserMessage: (message: string) => sent.push(message),
    } as unknown as ExtensionAPI);
    const event = { prompt: "fix this bug", systemPromptOptions: { sections: { existing: "kept" } as Record<string, string> } };
    const before = events.get("before_agent_start")!;
    before(event);
    const completion = event.systemPromptOptions.sections.task_completion;
    assert.ok(completion.length < 2700, "Keep completion and recovery guidance bounded");
    assert.match(completion, /Minimal code does not mean reduced scope/);
    assert.match(completion, /plan-only or read-only audit request does not authorize implementation/);
    assert.match(completion, /every requested outcome \(including annotations\), dependencies and acceptance checks/);
    assert.match(completion, /in-task strategy request does not cancel remaining work; honor explicit pauses/);
    assert.match(completion, /Continue authorized, unblocked work after each slice/);
    assert.match(completion, /do not ask whether to continue steps already requested/);
    assert.match(completion, /parent owns integration and verification/);
    assert.match(completion, /child completes its assigned task and write-set/);
    assert.match(completion, /use an available approval mechanism/);
    assert.match(completion, /Never bypass a denial, retry indefinitely/);
    assert.match(completion, /required human or review gates remain blocking/);
    assert.match(completion, /distinguish implemented, verified and awaiting human validation/);
    assert.match(completion, /Report partial work as partial/);
    assert.match(completion, /After a resolved blocker, approval or restart/);
    assert.match(completion, /resume the remaining authorized work in the same turn/);
    assert.match(completion, /unless the user explicitly pauses or limits the scope/);
    assert.match(completion, /do not repeat an unchanged denial/);
    assert.match(completion, /source integration, runtime installation, activation and application acceptance separately/);
    assert.match(completion, /name its exact next action/);
    assert.match(completion, /No unrequested commit, push or deployment/);
    const policy = event.systemPromptOptions.sections.adaptive_delegation;
    assert.match(policy, /then continue the remaining authorized requirements/);
    assert.match(policy, /Start direct for simple or tightly coupled work/);
    assert.match(policy, /Split progressively only after contracts are stable/);
    assert.match(policy, /first usable, tested slice before broad write delegation/);
    assert.match(policy, /parallel only for independent tasks/);
    assert.match(policy, /Set timeoutSeconds explicitly/);
    assert.match(policy, /no second correction round by default/);
    assert.match(policy, /coordination costs exceed the benefit/);
    assert.match(policy, /Resume an owned child/);
    assert.match(policy, /handle a different useful slice, not their same investigation/);
    assert.match(policy, /re-read only changed or missing evidence/);
    assert.match(policy, /Stop exploring when the next scoped change and its acceptance check are clear/);
    assert.match(policy, /No commit, push or deployment without explicit user authorization/);
    before(event);
    assert.equal(event.systemPromptOptions.sections.adaptive_delegation, policy, "no accumulating prompt text");
    tools = []; before(event);
    assert.equal(event.systemPromptOptions.sections.adaptive_delegation, undefined);
    assert.equal(event.systemPromptOptions.sections.task_completion, completion, "completion does not depend on delegation");
    tools = ["subagent"]; process.env.PI_SUBAGENT_CHILD = "1"; before(event);
    assert.equal(event.systemPromptOptions.sections.adaptive_delegation, undefined);
    assert.equal(event.systemPromptOptions.sections.task_completion, completion, "children own their assigned scope");
    assert.equal(event.systemPromptOptions.sections.existing, "kept");
    assert.equal(sent.length, 0, "prompt guidance must not start extra model turns");
    assert.equal(events.has("agent_end"), false);
    assert.equal(events.has("agent_settled"), false);
    delete process.env.PI_SUBAGENT_CHILD;
    assert.ok(command);
    await command("complete the requested changes", {} as Parameters<Handler>[1]);
    event.prompt = sent[0];
    before(event);
    assert.equal(event.systemPromptOptions.sections.adaptive_delegation, undefined, "explicit orchestration does not duplicate delegation guidance");
    assert.equal(event.systemPromptOptions.sections.task_completion, completion);
    assert.equal(sent.length, 1, "only the explicit command queued a user request");
  } finally {
    if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
  }
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
