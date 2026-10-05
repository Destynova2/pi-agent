import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { RpcProcess } from "../lib/rpc-process.ts";

test("persistent RPC streams UTF-8 requests, replies to host callbacks and bounds unterminated frames", async () => {
  let feedback = "";
  const rpc = new RpcProcess({ command: process.execPath, cwd: tmpdir(), onStderr: chunk => { feedback += chunk.toString(); }, args: ["-e", `
process.stderr.write('headless command feedback');
const rl = require('readline').createInterface({input:process.stdin});
rl.on('line', line => { const m=JSON.parse(line);
if(m.method) process.stdout.write(JSON.stringify({id:'callback',method:'echo',params:m})+'\\n');
else process.stdout.write(JSON.stringify({id:m.result.id,result:m.result.params})+'\\n'); });
`], onRequest: (_method, params) => params });
  rpc.start();
  try {
    for (const text of ["é \u{1F408}", "second request"]) assert.equal(await rpc.request("echo", text), text);
  } finally { await rpc.shutdown(); }
  assert.match(feedback, /headless command feedback/);
  const oversized = new RpcProcess({ command: process.execPath, cwd: tmpdir(), maxLineBytes: 256,
    args: ["-e", "process.stdin.once('data',()=>process.stdout.write('x'.repeat(1024)));setInterval(()=>{},1000)"] });
  oversized.start();
  await assert.rejects(oversized.request("go", {}), /frame limit/);
  await assert.rejects(oversized.shutdown(), /frame limit/);
});

test("RPC launch failure rejects pending requests and remains visible at shutdown", async () => {
  const rpc = new RpcProcess({ command: "/nonexistent/pi-rpc-test", cwd: tmpdir(), args: [] });
  rpc.start();
  await assert.rejects(rpc.request("go", {}), /ENOENT/);
  await assert.rejects(rpc.shutdown(), /ENOENT/);
});
