import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findPiPackageJson } from "../../../tests/resolve-pi.mjs";
import { runProcess } from "../../../lib/process.ts";

// A deterministic local provider exercises Pi's real tool pipeline, with no credentials/network.
const provider = `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
  if (process.env.FIXTURE_MUTATE) pi.on('tool_call', event => { event.input.path = 'changed.txt'; });
  pi.registerProvider('policy-fixture', {
    baseUrl: 'https://invalid.example', apiKey: 'unused', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const result = {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(() => {
        stream.push({type:'start',partial:result});
        const last = context.messages.findLast(m => m.role === 'toolResult');
        if (!last) {
          const call = {type:'toolCall',id:'call-fixture',name:process.env.FIXTURE_TOOL || 'write',arguments:process.env.FIXTURE_TOOL === 'subagent' ? {agent:'missing-fixture',task:'probe failure'} : {path:process.env.FIXTURE_PATH,content:'written'}};
          result.content.push(call); result.stopReason='toolUse';
          stream.push({type:'toolcall_start',contentIndex:0,partial:result});
          stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(call.arguments),partial:result});
          stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:result});
        } else {
          const text = JSON.stringify({isError:last.isError,text:last.content});
          result.content.push({type:'text',text});
          stream.push({type:'text_start',contentIndex:0,partial:result});
          stream.push({type:'text_delta',contentIndex:0,delta:text,partial:result});
          stream.push({type:'text_end',contentIndex:0,content:text,partial:result});
        }
        stream.push({type:'done',reason:result.stopReason,message:result}); stream.end();
      });
      return stream;
    }
  });
}
`;

for (const mode of ["headless-ask", "allow", "protected", "downstream-mutation", "subagent-error"]) {
  test(`real Pi tool authorization: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-policy-real-"));
    try {
      const agentDir = join(root, "agent"); await mkdir(agentDir);
      const policyFile = join(agentDir, "tool-policy.json");
      await writeFile(policyFile, JSON.stringify({ write: mode === "headless-ask" ? "ask" : "allow", subagent: "allow", "*": "deny" }));
      const fixture = join(root, "provider.ts"); await writeFile(fixture, provider);
      const packageJson = findPiPackageJson(); assert.ok(packageJson, "Pi install required");
      const manifest = JSON.parse(await readFile(packageJson, "utf8"));
      const cli = join(dirname(packageJson), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
      const output = await runProcess(process.execPath, [cli, "--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--extension", resolve("extensions/tool-policy/index.ts"), "--extension", fixture, ...(mode === "subagent-error" ? ["--extension", resolve("extensions/subagent/index.ts")] : []), "--tools", mode === "subagent-error" ? "subagent" : "write", "--model", "policy-fixture/fixture", "--mode", "json", "-p", "--no-session", "Exercise the tool"], {
        cwd: root, timeoutMs: 20000, maxBytes: 2 * 1024 * 1024,
        env: { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_CHILD: undefined, FIXTURE_TOOL: mode === "subagent-error" ? "subagent" : undefined, FIXTURE_PATH: mode === "protected" ? policyFile : join(root, "allowed.txt"), FIXTURE_MUTATE: mode === "downstream-mutation" ? "1" : undefined },
      });
      const messages = output.split("\n").filter(Boolean).map(line => JSON.parse(line));
      const final = messages.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1).message;
      const answer = JSON.parse(final.content.filter(p => p.type === "text").map(p => p.text).join(""));
      assert.equal(Boolean(answer.isError), mode !== "allow", JSON.stringify(answer));
      if (mode === "allow") assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), "written");
      else await assert.rejects(readFile(join(root, "allowed.txt")));
      await assert.rejects(readFile(join(root, "changed.txt")));
      assert.ok(JSON.parse(await readFile(policyFile, "utf8")).write);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
