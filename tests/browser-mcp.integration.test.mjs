import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mcp from "../extensions/mcp/index.ts";
import { APPROVAL_CHOICES, McpApprovals } from "../lib/mcp-approvals.ts";
import { localPodman } from "../lib/podman-connection.ts";
import { runProcess } from "../lib/process.ts";

test("optional browser profile: real consent, localhost origin, DOM, click, screenshot, confinement, revocation and cancellation", {
  skip: !process.env.PI_TEST_BROWSER_IMAGE && "Optional profile not selected; set PI_TEST_BROWSER_IMAGE to qualify its exact image",
  timeout: 90000,
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-browser-native-")));
  const cwd = join(root, "project"), agent = join(root, "agent"), sentinel = join(root, "host-only");
  mkdirSync(cwd); mkdirSync(agent); writeFileSync(sentinel, "host-only-sentinel");
  const oldAgent = process.env.PI_CODING_AGENT_DIR, oldSecret = process.env.PI_BROWSER_TEST_SECRET;
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_BROWSER_TEST_SECRET = "must-not-enter-container";
  const handlers = new Map(), commands = new Map(); let tool, prompts = 0;
  mcp({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, registerCommand: (name, value) => commands.set(name, value) });
  const site = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><title>Browser fixture</title><h1>Local browser fixture</h1><button onclick="document.querySelector(\'output\').textContent=\'Click verified\'">Verify click</button><output></output>');
  });
  t.after(async () => {
    await handlers.get("session_shutdown")();
    site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldSecret === undefined) delete process.env.PI_BROWSER_TEST_SECRET; else process.env.PI_BROWSER_TEST_SECRET = oldSecret;
    rmSync(root, { recursive: true, force: true });
  });
  // Podman machine reaches the host service through host.containers.internal.
  await new Promise((resolve, reject) => { site.once("error", reject); site.listen(0, "0.0.0.0", resolve); });
  const port = site.address().port;
  const definition = { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--isolated"], network: true,
    browser: { image: process.env.PI_TEST_BROWSER_IMAGE, localhostPorts: [port] } };
  const save = () => writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { fixture: definition } }));
  save();
  const engine = await localPodman(cwd, agent);
  const podman = args => runProcess(engine.executable.command, [...engine.prefix, ...args], { cwd, env: engine.env, timeoutMs: 15000, maxBytes: 65536 });
  const containers = async () => (await podman(["ps", "--all", "--filter", "label=io.pi-agent.browser-mcp=1", "--format", "{{.ID}}"])).trim().split("\n").filter(Boolean).sort();
  const before = await containers();
  const ctx = { cwd, hasUI: false, ui: { select: async (title, choices) => {
    prompts++;
    if (title.includes("Autoriser le navigateur")) { assert.match(title, /Aucun dossier/); assert.deepEqual(choices, APPROVAL_CHOICES); return APPROVAL_CHOICES[3]; }
    return choices.includes(APPROVAL_CHOICES[2]) ? APPROVAL_CHOICES[2] : APPROVAL_CHOICES[1];
  }, confirm: async () => true, notify() {} } };
  const call = (name = "help", args = {}, signal) => tool.execute("browser-fixture", { server: "fixture", tool: name, args }, signal, undefined, ctx);
  const text = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  await assert.rejects(call(), /human approval/);
  assert.deepEqual(await containers(), before);
  ctx.hasUI = true;
  assert.match(text(await call()), /25 tools/);
  assert.equal(prompts, 1);
  const owned = (await containers()).filter(id => !before.includes(id)); assert.equal(owned.length, 1);
  const confinement = JSON.parse(await podman(["exec", owned[0], "node", "-e",
    'const fs=require("node:fs");let denied=false;try{fs.writeFileSync("/etc/pi-browser-probe","bad")}catch{denied=true}console.log(JSON.stringify({uid:process.getuid(),denied,host:fs.existsSync(process.argv[1]),secret:process.env.PI_BROWSER_TEST_SECRET}))', sentinel]));
  assert.deepEqual(confinement, { uid: 1000, denied: true, host: false });
  const mounts = JSON.parse(await podman(["inspect", "--format", "{{json .Mounts}}", owned[0]]));
  assert.ok(mounts.every(mount => mount.Type === "tmpfs"), "no host directory or volume mounts");
  assert.match(text(await call("browser_navigate", { url: `http://127.0.0.1:${port}/` })), new RegExp(`http://127.0.0.1:${port}/`));
  const snapshot = text(await call("browser_snapshot"));
  const ref = snapshot.match(/button "Verify click" \[ref=(e\d+)\]/)?.[1]; assert.ok(ref, snapshot);
  await call("browser_click", { element: "Verify click", target: ref });
  assert.match(text(await call("browser_snapshot")), /Click verified/);
  const screenshot = await call("browser_take_screenshot", { type: "png" });
  const png = screenshot.content.find(item => item.type === "image"); assert.ok(png);
  assert.equal(Buffer.from(png.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  new McpApprovals(agent).revoke(cwd, "mcp-browser:fixture");
  await assert.rejects(call(), /stale|revoked/);
  assert.deepEqual(await containers(), before);
  await call();
  await commands.get("mcp").handler("permissions fixture", ctx);
  assert.deepEqual(await containers(), before);
  ctx.hasUI = false; await assert.rejects(call(), /human approval/); ctx.hasUI = true;
  await call();
  // Changing a definition stops the old browser before a replacement is approved.
  definition.browser.localhostPorts = []; save(); ctx.hasUI = false;
  await assert.rejects(call(), /human approval/); assert.deepEqual(await containers(), before); ctx.hasUI = true;
  await call();
  const controller = new AbortController();
  const waiting = assert.rejects(call("browser_wait_for", { time: 60 }, controller.signal), /canceled|abort/i);
  const timer = setTimeout(() => controller.abort(), 500);
  try { await waiting; } finally { clearTimeout(timer); }
  assert.deepEqual(await containers(), before);
});
