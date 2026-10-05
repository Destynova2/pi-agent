import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJjCheckpoint } from "../extensions/tool-policy/jj-checkpoint.ts";
import { inspectCheckpoint, runCheckpoint } from "../lib/jj-checkpoint.ts";
import { APPROVAL_CHOICES, serverIdentity } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  try { serverIdentity("jj", [], process.cwd()); }
  catch (error) {
    if (process.env.PI_TEST_INTEGRATION === "1") throw error;
    t.skip("jj is not installed; checkpoint fixtures require jj"); return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-checkpoint-access-"))), cwd = join(root, "repo"), agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG"], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: join(root, "jj.toml") });
  writeFileSync(process.env.JJ_CONFIG, '[user]\nname="Fixture"\nemail="fixture@example.com"\n');
  execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd, stdio: "ignore" }); writeFileSync(join(cwd, "file"), "original\n");
  const handlers = new Map(), commands = new Map(), state = { prompts: 0, dispatches: 0, active: true };
  let tool;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { state.prompts++; return choices[1]; }, notify() {} } };
  registerJjCheckpoint({ on: (name, fn) => handlers.set(name, fn), registerTool: value => { tool = value; }, registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => state.active ? ["jj_checkpoint"] : [] }, agent, () => {}, async (_program, args, options) => {
    assert.ok(args.includes("--offline"), "no network grant for checkpoints");
    const data = JSON.parse(options.input);
    if (data.action === "inspect") return JSON.stringify({ result: await inspectCheckpoint(options.cwd, data.binary, options.signal) });
    state.dispatches++; assert.notEqual(options.cwd, cwd, "worker uses disposable workspace");
    const roots = JSON.parse(args[args.indexOf("--write-roots") + 1]);
    assert.deepEqual(roots, [join(options.cwd, ".git")]);
    assert.ok(!roots.some(path => path.startsWith(cwd + "/")));
    const result = await runCheckpoint(options.cwd, data.binary, options.signal);
    if (state.changeSource) writeFileSync(join(cwd, "file"), "concurrent edit\n");
    if (state.workerFailure) throw new Error("fixture worker refused");
    return JSON.stringify({ result });
  });
  t.after(async () => {
    await handlers.get("session_shutdown")();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { cwd, ctx, state, handlers, commands, request: signal => tool.execute("fixture", { reason: "before edits" }, signal, undefined, ctx) };
}

test("initialization asks once; later snapshots have separate reusable project consent and revocation", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return; assert.equal(CONFINED_TOOLS.has("jj_checkpoint"), false);
  f.ctx.ui.select = async (_title, choices) => { f.state.prompts++; assert.deepEqual(choices, APPROVAL_CHOICES.slice(0, 2)); return choices[1]; };
  const first = JSON.parse((await f.request()).content[0].text); assert.match(first.operationId, /^[a-f0-9]{128}$/);
  f.ctx.ui.select = async (_title, choices) => { f.state.prompts++; assert.deepEqual(choices, APPROVAL_CHOICES); return choices[3]; };
  await f.request(); writeFileSync(join(f.cwd, "file"), "next\n"); await f.request();
  assert.equal(f.state.prompts, 2); assert.equal(f.state.dispatches, 3);
  await f.handlers.get("session_start")(); await f.request(); assert.equal(f.state.prompts, 2);
  await f.commands.get("jj-checkpoint").handler("permissions", f.ctx);
  f.ctx.ui.select = async () => undefined; await assert.rejects(f.request(), /not approved/);
});

test("refusal, missing UI, inactive tool and children cannot initialize or snapshot", async t => {
  const f = fixture(t); if (!f) return;
  f.ctx.hasUI = false; await assert.rejects(f.request(), /interactive parent/); f.ctx.hasUI = true;
  f.state.active = false; await assert.rejects(f.request(), /interactive parent/); f.state.active = true;
  const previous = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(f.request(), /interactive parent/); }
  finally { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; }
  f.ctx.ui.select = async () => APPROVAL_CHOICES[0]; await assert.rejects(f.request(), /not approved/);
  f.ctx.ui.select = async () => APPROVAL_CHOICES[1]; await assert.rejects(f.request(), /refused earlier/);
  assert.equal(f.state.dispatches, 0); assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

test("source changes and worker failure cannot publish; session cancellation invalidates pending consent", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return; f.state.changeSource = true;
  await assert.rejects(f.request(), /source changed/); assert.equal(existsSync(join(f.cwd, ".jj")), false);
  f.state.changeSource = false; f.state.workerFailure = true;
  await assert.rejects(f.request(), /worker refused/); assert.equal(existsSync(join(f.cwd, ".jj")), false);
  f.ctx.ui.select = async () => { void f.handlers.get("session_start")(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request(), /abort|cancel|stale/i); assert.equal(f.state.dispatches, 2);
});
