import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../lib/rpc-process.ts";
import { McpConnection } from "../extensions/mcp/client.ts";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
test("local MCP persists inside the real jail, denies outside writes, and cancellation reaps descendants", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-")));
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const rpc = new RpcProcess({
    command: fileURLToPath(new URL("../scripts/codex-shell.mjs", import.meta.url)), cwd,
    args: ["--offline", "-c", [process.execPath, fileURLToPath(new URL("fixtures/mcp-server.mjs", import.meta.url))].map(quote).join(" ")],
  });
  const connection = new McpConnection(rpc);
  try {
    const help = (await connection.call("help", {})).content[0].text;
    assert.match(help, /2 tools:[\s\S]*probe:[\s\S]*hang:/);
    assert.match((await connection.call("help", { name: "probe" })).content[0].text, /inputSchema/);
    const first = JSON.parse((await connection.call("probe", { path: join(cwd, "inside") })).content[0].text);
    assert.ok(first.sandbox);
    assert.equal(readFileSync(join(cwd, "inside"), "utf8"), "written");
    writeFileSync(join(root, "outside"), "untouched");
    const second = JSON.parse((await connection.call("probe", { path: join(root, "outside") })).content[0].text);
    assert.equal(first.pid, second.pid);
    assert.equal(second.calls, 2);
    assert.equal(second.denied, true);
    assert.equal(readFileSync(join(root, "outside"), "utf8"), "untouched");
    const pidFile = join(cwd, "pid");
    await assert.rejects(rpc.request("tools/call", { name: "hang", arguments: { pidFile } }, { timeoutMs: 700 }), /timed out/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    // SIGKILL has been sent before cancellation settles; Darwin may briefly retain the zombie.
    let gone = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; gone = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(gone, true, "canceled MCP descendants must be reaped");
  } finally { await rpc.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
