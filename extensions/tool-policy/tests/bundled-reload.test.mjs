import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { findPiPackageJson } from "../../../tests/resolve-pi.mjs";

// Unlike a policy-JSON edit, this checks replacement of loaded extension code in the actual CLI.
test("installed CLI reload replaces extension source without a restart or provider call", async () => {
  const packageJson = findPiPackageJson();
  assert.ok(packageJson, "Pi installation required");
  const manifest = JSON.parse(await readFile(packageJson, "utf8"));
  const cli = join(dirname(packageJson), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
  const root = await mkdtemp(join(tmpdir(), "pi-bundled-reload-"));
  const fixture = join(root, "fixture.ts");
  const source = version => `export default function(pi) {
    pi.registerCommand('probe', { handler: async (_, ctx) => ctx.ui.notify('revision-${version}', 'info') });
    pi.registerCommand('probe-reload', { handler: async (_, ctx) => { await ctx.waitForIdle(); await ctx.reload(); } });
  }`;
  let child;
  let exited;
  let timer;
  try {
    await writeFile(fixture, source("old"));
    child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", fixture], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    let buffer = "", stderr = "", sequence = 0;
    const messages = [];
    const pending = new Map();
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdout.setEncoding("utf8").on("data", chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        messages.push(message);
        if (message.type === "response" && pending.has(message.id)) {
          pending.get(message.id)(message); pending.delete(message.id);
        }
      }
    });
    timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    const request = async command => {
      const id = String(++sequence);
      const response = new Promise(resolve => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      const result = await Promise.race([response, exited.then(() => { throw new Error("Pi exited: " + stderr); })]);
      assert.equal(result.success, true, JSON.stringify(result));
      return result;
    };
    const commands = await request({ type: "get_commands" });
    assert.ok(commands.data.commands.some(command => command.name === "probe"));
    await request({ type: "prompt", message: "/probe" });
    await writeFile(fixture, source("new"));
    await request({ type: "prompt", message: "/probe-reload" });
    await request({ type: "prompt", message: "/probe" });
    const notices = messages.filter(message => message.method === "notify" && message.message.startsWith("revision-")).map(message => message.message);
    assert.deepEqual(notices, ["revision-old", "revision-new"]);
    assert.equal(messages.some(message => message.type === "agent_start"), false, "No model run permitted");
  } finally {
    child?.stdin.end();
    await exited;
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});
