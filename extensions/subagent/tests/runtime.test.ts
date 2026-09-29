import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import register from "../index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const taskArg = process.argv.find(a => a.startsWith('@'));
if (!taskArg) throw new Error('task must travel via file, not argv');
const task = fs.readFileSync(taskArg.slice(1), 'utf8');
const emit = (text, stopReason = 'stop') => console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text',text}], stopReason, usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}}));
fs.appendFileSync('started', '1');
if (task.includes('SIGNAL')) {
  emit('partial before signal', 'toolUse'); process.kill(process.pid, 'SIGTERM');
} else if (task.includes('EMPTY')) {
  // successful process exit is not an actual assistant answer
} else if (task.includes('LENGTH')) {
  emit('unfinished answer', 'length');
} else if (task.includes('TAIL_ERROR')) {
  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'partial tail'}],stopReason:'error',errorMessage:'provider rate limit'}}));
  console.error('fixture failed'); process.exitCode = 7;
} else if (task.includes('ERROR')) {
  console.error('fixture failed'); process.exitCode = 7;
} else if (task.includes('HANG')) {
  process.on('SIGTERM',()=>{});
  const child = spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync('child-ready',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
  fs.writeFileSync('parent-pid',String(process.pid));
  emit('working', 'toolUse');
  setInterval(()=>{},1000);
} else if (task.includes('BIG')) {
  emit('é'.repeat(600000));
} else if (task.includes('CHAIN_NEXT')) {
  const report = task.match(/Report: (.+)/)?.[1];
  if (!report || fs.readFileSync(report,'utf8').length < 500000) throw new Error('missing full handoff');
  emit('read complete prior report');
} else if (task.includes('MANY')) {
  for (let i=0;i<80;i++) emit('progress '+i,'toolUse');
  emit('complete');
} else {
  const text = JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'été'},{type:'text',text:task.length.toString()}],stopReason:'stop'}});
  const bytes = Buffer.from(text+'\\n');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  process.stdout.write(bytes.subarray(0,split));
  setTimeout(()=>process.stdout.write(bytes.subarray(split)),30);
  fs.writeFileSync('child-env',JSON.stringify({child:process.env.PI_SUBAGENT_CHILD,name:process.env.PI_AGENT_NAME,args:process.argv.slice(2)}));
}
`;

async function withTool(fn: (execute: (...args: any[]) => Promise<any>, root: string, render: (result: any) => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-runtime-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldChild = process.env.PI_SUBAGENT_CHILD;
  const oldScript = process.argv[1];
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    delete process.env.PI_SUBAGENT_CHILD;
    await mkdir(join(root, "agent/agents"), { recursive: true });
    await writeFile(join(root, "agent/agents/fixture.md"), "---\nname: fixture\ndescription: offline process fixture\nmodel: fixture/model\n---\nReturn the requested fixture.\n");
    process.argv[1] = join(root, "fake-pi.mjs");
    await writeFile(process.argv[1], fixture);
    let tool: any;
    register({ on: () => {}, registerTool: (value: any) => { tool = value; }, getActiveTools: () => ["read", "write", "bash", "subagent"] } as any);
    const execute = (params: any, signal?: AbortSignal, onUpdate?: any) => tool.execute("test", params, signal, onUpdate, { cwd: root, hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "parent-test", getSessionFile: () => undefined } });
    const render = (result: any) => tool.renderResult(result, { expanded: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}).render(120).join("\n");
    await fn(execute, root, render);
  } finally {
    process.argv[1] = oldScript;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
    await rm(root, { recursive: true, force: true });
  }
}

test("file task transport handles large input, split UTF-8, all text blocks and private artifacts", async () => {
  await withTool(async (execute, root) => {
    const task = "x".repeat(200000);
    const result = await execute({ agent: "fixture", task });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /été\n200006/);
    const details = result.details.results[0];
    assert.equal(await readFile(details.reportPath, "utf8"), "été\n200006");
    assert.ok((await readFile(details.tracePath, "utf8")).includes("message_end"));
    assert.equal((await stat(details.reportPath)).mode & 0o777, 0o600);
    assert.equal((await stat(details.tracePath)).mode & 0o777, 0o600);
    const env = JSON.parse(await readFile(join(root, "child-env"), "utf8"));
    assert.equal(env.child, "1");
    assert.match(env.name, /^fixture-run-/);
    assert.ok(env.args.includes("--no-approve"));
    assert.ok(!env.args.includes("--no-session"));
    assert.equal(env.args[env.args.indexOf("--tools") + 1], "read,write", "headless children cannot gain ask/deny tools or recurse");
    assert.equal(env.args[env.args.indexOf("--session") + 1], details.sessionPath);
    const resumed = await execute({ agent: "fixture", task: "next task", resume: details.resumeId });
    assert.ok(!resumed.isError);
    assert.equal(resumed.details.results[0].sessionPath, details.sessionPath);
    assert.notEqual(resumed.details.results[0].reportPath, details.reportPath);
    assert.equal(await readFile(details.reportPath, "utf8"), "été\n200006");
  });
});

test("single, parallel and chain reports are bounded and complete output is readable", async () => {
  await withTool(async (execute) => {
    for (const params of [{ agent: "fixture", task: "BIG" }, { tasks: [{ agent: "fixture", task: "BIG" }] }]) {
      const result = await execute(params);
      assert.ok(!result.isError);
      assert.ok(Buffer.byteLength(result.content[0].text) < 14000);
      assert.match(result.content[0].text, /truncated/);
      const report = await readFile(result.details.results[0].reportPath, "utf8");
      assert.equal(report, "é".repeat(600000));
      assert.ok(!result.content[0].text.includes("\ufffd"));
    }
    const chained = await execute({ chain: [{ agent: "fixture", task: "BIG" }, { agent: "fixture", task: "CHAIN_NEXT {previous}" }] });
    assert.ok(!chained.isError);
    assert.match(chained.content[0].text, /read complete prior report/);
    assert.ok(Buffer.byteLength(chained.details.results[1].task) < 14000);
  });
});

test("signals, nonzero exits, missing final answers and length limits never report success", async () => {
  await withTool(async (execute, root) => {
    for (const task of ["SIGNAL", "ERROR", "EMPTY", "LENGTH", "TAIL_ERROR"]) {
      const result = await execute({ agent: "fixture", task });
      assert.equal(result.isError, true, task);
      assert.equal(result.details.results[0].exitCode, 1);
      assert.match(await readFile(result.details.results[0].reportPath, "utf8"), /^FAILED:/);
      if (task === "SIGNAL") assert.match(await readFile(result.details.results[0].reportPath, "utf8"), /partial before signal/);
      if (task === "TAIL_ERROR") {
        assert.match(result.content[0].text, /provider rate limit/);
        assert.match(result.content[0].text, /code 7/);
        assert.match(await readFile(result.details.results[0].reportPath, "utf8"), /partial tail/);
      }
    }
    const before = (await readFile(join(root, "started"), "utf8")).length;
    const chain = await execute({ chain: [{ agent: "fixture", task: "ERROR" }, { agent: "fixture", task: "must not start" }] });
    assert.equal(chain.isError, true);
    assert.equal((await readFile(join(root, "started"), "utf8")).length, before + 1);
    const parallel = await execute({ tasks: [{ agent: "fixture", task: "ERROR" }, { agent: "fixture", task: "ok" }] });
    assert.equal(parallel.isError, true);
    assert.match(parallel.content[0].text, /1\/2 succeeded/);
  });
});

for (const mode of ["timeout", "abort"]) {
  test(`${mode}: stop the entire subagent process group, retain partial results`, async () => {
    await withTool(async (execute, root, render) => {
      const controller = new AbortController();
      const updates: any[] = [];
      const job = execute({ agent: "fixture", task: "HANG", timeoutSeconds: mode === "timeout" ? 1 : 10 }, controller.signal, (update: any) => {
        updates.push(update.details.results[0].exitCode);
        assert.match(render(update), /⏳/);
        assert.doesNotMatch(render(update), /✗/);
        assert.doesNotMatch(update.content[0].text, /Report:/);
        const chainView = { ...update, details: { ...update.details, mode: "chain" } };
        assert.match(render(chainView), /⏳/);
        assert.doesNotMatch(render(chainView), /✗/);
      });
      try {
        for (let i = 0; i < 200; i++) {
          try { await stat(join(root, "child-ready")); break; } catch { await delay(10); }
        }
        const child = Number(await readFile(join(root, "child-ready"), "utf8"));
        const parent = Number(await readFile(join(root, "parent-pid"), "utf8"));
        if (mode === "abort") controller.abort();
        const result = await job;
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, mode === "timeout" ? /deadline/ : /canceled/);
        assert.ok(updates.length > 0 && updates.every((code) => code === -1));
        assert.throws(() => process.kill(parent, 0), { code: "ESRCH" });
        // An orphan may briefly remain as a zombie on Linux, but must not be running.
        try {
          const status = await readFile(`/proc/${child}/status`, "utf8");
          assert.match(status, /State:\s+Z/);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        assert.match(await readFile(result.details.results[0].reportPath, "utf8"), /working/);
      } finally { controller.abort(); await job; }
    });
  });
}

test("already canceled parallel requests never spawn queued children", async () => {
  await withTool(async (execute, root) => {
    const controller = new AbortController(); controller.abort();
    const result = await execute({ tasks: Array.from({ length: 8 }, () => ({ agent: "fixture", task: "ok" })) }, controller.signal);
    assert.equal(result.isError, true);
    assert.equal(result.details.results.length, 8);
    assert.ok(!(await readdir(root)).includes("started"));
  });
});

test("explicit empty/malformed role tools do not inherit; requested tools cannot widen the parent policy", async () => {
  await withTool(async (execute, root) => {
    for (const value of ["[]", "123", "[read, bash, subagent, hidden_tool]"]) {
      await writeFile(join(root, "agent/agents/fixture.md"), `---\nname: fixture\ndescription: fixture\ntools: ${value}\n---\nRead only.\n`);
      const result = await execute({ agent: "fixture", task: "ok" });
      assert.ok(!result.isError);
      const { args } = JSON.parse(await readFile(join(root, "child-env"), "utf8"));
      if (value.startsWith("[read")) assert.equal(args[args.indexOf("--tools") + 1], "read");
      else assert.ok(args.includes("--no-tools"));
    }
  });
});

test("headless project agents cannot bypass confirmation with flags or general project trust", async () => {
  await withTool(async (execute, root) => {
    await mkdir(join(root, ".pi/agents"), { recursive: true });
    await writeFile(join(root, ".pi/agents/repo.md"), "---\nname: repo\ndescription: repo agent\n---\nDo something.\n");
    for (const confirmProjectAgents of [true, false]) {
      const result = await execute({ agent: "repo", task: "ok", agentScope: "project", confirmProjectAgents });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /human approval/);
      assert.ok(!(await readdir(root)).includes("started"));
    }
  });
});

test("UI history stays bounded while the full trace preserves earlier turns", async () => {
  await withTool(async (execute) => {
    const result = await execute({ agent: "fixture", task: "MANY" });
    assert.ok(!result.isError);
    const details = result.details.results[0];
    assert.equal(details.messages.length, 40);
    assert.equal(details.usage.turns, 81);
    assert.match(await readFile(details.tracePath, "utf8"), /progress 0/);
  });
});
