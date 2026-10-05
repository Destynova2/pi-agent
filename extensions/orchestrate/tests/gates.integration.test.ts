import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index.ts";

test("orchestrate gates enters the real jail and cannot write outside the project", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gates-jail-"));
  const agent = join(root, "agent"), cwd = join(root, "project"), outside = join(root, "outside");
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_GATES_BIN: process.env.PI_GATES_BIN };
  const events = new Map();
  let command: any;
  const notifications: string[] = [];
  try {
    mkdirSync(join(agent, "scripts"), { recursive: true }); mkdirSync(cwd);
    for (const file of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) cpSync(new URL(`../../../scripts/${file}`, import.meta.url), join(agent, "scripts", file));
    writeFileSync(outside, "untouched");
    const probe = join(agent, "probe.mjs");
    writeFileSync(probe, `#!${process.execPath}\nimport fs from 'node:fs';let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch(e){denied=['EPERM','EACCES','EROFS'].includes(e.code)};fs.writeFileSync('inside','ok');console.log(JSON.stringify({denied,sandbox:!!process.env.PI_CONFINED,mode:process.argv[2]}));\n`, { mode: 0o755 });
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_GATES_BIN: probe });
    register({ on: (name: string, handler: any) => events.set(name, handler), registerCommand: (_name: string, value: any) => { command = value; } } as any);
    await command.handler("gates quick", { cwd, ui: { setStatus() {}, notify: (text: string) => notifications.push(text) } });
    assert.ok(!notifications.at(-1)!.startsWith("Gates BLOCKED:"), notifications.at(-1));
    assert.deepEqual(JSON.parse(notifications.at(-1)!), { denied: true, sandbox: true, mode: "quick" });
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    assert.equal(readFileSync(join(cwd, "inside"), "utf8"), "ok");
  } finally {
    await events.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
