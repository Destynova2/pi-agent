import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
let calls = 0;
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  else if (method === "tools/list") send(id, { tools: [{ name: "probe", inputSchema: { type: "object" } }, { name: "hang" }] });
  else if (method === "tools/call") {
    if (params.name === "hang") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      writeFileSync(params.arguments.pidFile, String(child.pid));
      continue;
    }
    let denied = false;
    if (params.arguments.path) {
      try { writeFileSync(params.arguments.path, "written"); }
      catch (error) { denied = ["EPERM", "EACCES", "EROFS"].includes(error.code); if (!denied) throw error; }
    }
    send(id, { content: [{ type: "text", text: JSON.stringify({ denied, pid: process.pid, calls: ++calls, sandbox: process.env.PI_CONFINED }) }] });
  }
}
