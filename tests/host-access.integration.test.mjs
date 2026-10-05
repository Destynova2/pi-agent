import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHostAccess } from "../extensions/tool-policy/host-access.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { runProcess } from "../lib/process.ts";

// Real CLI/formatting, synthetic local API only. Never connect to the user's Podman service.
test("real Podman CLI returns projected diagnostics and suppresses secret-bearing API errors", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-api-"))), cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const id = "a".repeat(64), secret = "FIXTURE_PRIVATE_VALUE_NOT_A_CREDENTIAL", requests = [];
  let fail = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture.invalid").pathname; requests.push(path);
    response.setHeader("Libpod-API-Version", "6.1.2"); response.setHeader("API-Version", "1.41");
    if (path.endsWith("/_ping")) { response.end("OK"); return; }
    response.setHeader("Content-Type", "application/json");
    if (fail) { response.writeHead(500); response.end(JSON.stringify({ cause: "permission denied", message: `permission denied ${secret}`, response: 500 })); return; }
    if (path.endsWith("/containers/json")) { response.end(JSON.stringify([{ Id: id, Names: ["fixture"], State: "running", Ports: [{ host_ip: "127.0.0.1", container_port: 9091, host_port: 9091, protocol: "tcp" }] }])); return; }
    if (path.endsWith("/containers/fixture/json")) { response.end(JSON.stringify({ Id: id, Name: "fixture", State: { Status: "running" }, Config: { Env: [`APP_PASSWORD=${secret}`, "APP_PUBLIC_URL=http://localhost:9091"] }, NetworkSettings: { Ports: {} } })); return; }
    if (path.endsWith("/containers/fixture/logs")) {
      const url = new URL(request.url, "http://fixture.invalid");
      assert.equal(url.searchParams.get("tail"), "7");
      assert.notEqual(url.searchParams.get("follow"), "true");
      response.setHeader("Content-Type", "application/vnd.docker.raw-stream");
      const frame = (stream, message) => { const bytes = Buffer.from(message), header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); };
      response.end(Buffer.concat([frame(1, "stdout fixture\n"), frame(2, "stderr fixture\u001b[31m\n")])); return;
    }
    response.writeHead(404); response.end(JSON.stringify({ message: "Unknown fixture route", response: 404 }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `tcp://127.0.0.1:${server.address().port}`;
  const old = process.env.PI_PODMAN_BIN; delete process.env.PI_PODMAN_BIN;
  const tools = new Map(), handlers = new Map();
  try {
    registerHostAccess({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, getActiveTools: () => [...tools.keys()] }, agent, () => {}, (program, args, options) => runProcess(program, ["--url", endpoint, ...args], { ...options, env: { ...options.env, HOME: root, XDG_CONFIG_HOME: root, CONTAINER_HOST: endpoint, CONTAINER_CONNECTION: undefined, CONTAINERS_CONF: undefined, CONTAINERS_CONF_OVERRIDE: undefined, PODMAN_CONNECTIONS_CONF: undefined } }));
    const ctx = { cwd, hasUI: true, ui: { select: async () => APPROVAL_CHOICES[1] } };
    const call = operation => tools.get("request_host_access").execute("fixture", { operation, reason: "Offline synthetic API fixture", ...(operation === "podman_inspect" ? { target: "fixture" } : {}) }, undefined, undefined, ctx);
    const listed = JSON.parse((await call("podman_list")).content[0].text);
    assert.equal(listed[0].name, "fixture"); assert.equal(listed[0].id, id); assert.match(listed[0].ports, /9091/);
    const inspected = (await call("podman_inspect")).content[0].text;
    assert.match(inspected, /http:\/\/localhost:9091/); assert.match(inspected, /APP_PASSWORD/); assert.doesNotMatch(inspected, new RegExp(secret));
    const logs = await tools.get("request_host_access").execute("logs", { operation: "podman_logs", target: "fixture", tail: 7, reason: "Synthetic logs only" }, undefined, undefined, ctx);
    assert.match(logs.content[0].text, /stdout fixture/); assert.match(logs.content[0].text, /stderr fixture/);
    assert.doesNotMatch(logs.content[0].text, /\u001b/); assert.match(logs.content[0].text, /\\u001b/);
    fail = true;
    await assert.rejects(call("podman_list"), error => /\[permission\]/.test(error.message) && !error.message.includes(secret));
    assert.ok(requests.some(path => path.endsWith("/containers/json"))); assert.ok(requests.some(path => path.endsWith("/containers/fixture/json")));
  } finally {
    await handlers.get("session_shutdown")?.();
    if (old === undefined) delete process.env.PI_PODMAN_BIN; else process.env.PI_PODMAN_BIN = old;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
