import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerJjCheckpoint } from "../extensions/tool-policy/jj-checkpoint.ts";
import { inspectCheckpoint, runCheckpoint } from "../lib/jj-checkpoint.ts";
import { APPROVAL_CHOICES, serverIdentity } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { runProcess } from "../lib/process.ts";
import { LINUX_STDIO_RELAY } from "../scripts/codex-shell.mjs";

function fixture(t) {
  try { serverIdentity("jj", [], process.cwd()); }
  catch (error) {
    if (process.env.PI_TEST_INTEGRATION === "1") throw error;
    t.skip("jj is not installed; checkpoint fixtures require jj"); return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-checkpoint-access-"))), workspace = join(root, "workspace"), cwd = join(workspace, "repo"), agent = join(root, "agent");
  mkdirSync(workspace); mkdirSync(cwd); mkdirSync(agent);
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG"], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: join(root, "jj.toml") });
  writeFileSync(process.env.JJ_CONFIG, '[user]\nname="Fixture"\nemail="fixture@example.com"\n');
  execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd, stdio: "ignore" }); writeFileSync(join(cwd, "file"), "original\n");
  const handlers = new Map(), commands = new Map(), state = { prompts: 0, dispatches: 0, active: true, inspections: [] };
  let tool;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { state.prompts++; return choices[1]; }, notify() {} } };
  registerJjCheckpoint({ on: (name, fn) => handlers.set(name, fn), registerTool: value => { tool = value; }, registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => state.active ? ["jj_checkpoint"] : [] }, agent, () => {}, async (_program, args, options) => {
    assert.ok(args.includes("--offline"), "no network grant for checkpoints");
    const data = JSON.parse(options.input);
    if (data.action === "inspect") {
      state.inspections.push({ cwd: options.cwd, repository: data.repository });
      const result = await inspectCheckpoint(data.repository ?? options.cwd, data.binary, options.signal);
      state.inspectedRoot = result.root;
      state.afterInspection?.();
      return JSON.stringify({ result });
    }
    state.dispatches++; assert.notEqual(options.cwd, cwd, "worker uses disposable workspace");
    const roots = JSON.parse(args[args.indexOf("--write-roots") + 1]);
    assert.deepEqual(roots, [join(options.cwd, ".git")]);
    assert.ok(!roots.some(path => path.startsWith(cwd + "/")));
    const readRoots = JSON.parse(args[args.indexOf("--read-roots") + 1]);
    assert.ok(readRoots.includes(join(state.inspectedRoot, ".git/objects")), "original object pool is explicitly read-only");
    assert.ok(readRoots.includes(join(options.cwd, ".git/objects/info")), "alternate pointer is read-only");
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
  return { root, workspace, cwd, ctx, state, handlers, commands, tool, request: (signal, input = {}) => tool.execute("fixture", { reason: "before edits", ...input }, signal, undefined, ctx) };
}

for (const location of ["parent", "sibling"]) test(`explicit repository checkpoints from a ${location} session without broadening inspection writes`, { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return;
  const workspace = location === "parent" ? f.workspace : join(f.workspace, "sibling");
  if (location === "sibling") mkdirSync(workspace);
  f.ctx.cwd = workspace;
  writeFileSync(join(workspace, "outside"), "not part of the checkpoint\n");
  const config = readFileSync(join(f.cwd, ".git/config"));
  const result = JSON.parse((await f.request(undefined, { repository: f.cwd })).content[0].text);
  assert.equal(result.root, f.cwd);
  assert.match(result.operationId, /^[a-f0-9]{128}$/);
  assert.equal(await runProcess("/usr/bin/git", ["show", `${result.gitRef}:file`], { cwd: f.cwd }), "original");
  assert.deepEqual(readFileSync(join(f.cwd, ".git/config")), config);
  assert.equal(readFileSync(join(f.cwd, "file"), "utf8"), "original\n");
  assert.equal(existsSync(join(workspace, ".git")), false);
  assert.equal(existsSync(join(workspace, ".jj")), false);
  assert.ok(f.state.inspections.length >= 3);
  assert.ok(f.state.inspections.every(call => call.cwd === workspace && call.repository === f.cwd));
  assert.equal(f.tool.parameters.properties.repository.type, "string");
});

test("named repository consent and revocation stay scoped to that repository", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return;
  f.ctx.cwd = f.workspace;
  const request = repository => f.request(undefined, { repository });
  await request(f.cwd);
  f.ctx.ui.select = async () => { f.state.prompts++; return APPROVAL_CHOICES[3]; };
  await request(f.cwd);
  const other = join(f.workspace, "other"); mkdirSync(other);
  execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd: other, stdio: "ignore" });
  writeFileSync(join(other, "file"), "other repository\n");
  f.ctx.ui.select = async () => { f.state.prompts++; return APPROVAL_CHOICES[1]; };
  await request(other);
  assert.equal(f.state.prompts, 3, "one repository's consent cannot authorize another");
  await f.commands.get("jj-checkpoint").handler(`permissions ${f.cwd}`, f.ctx);
  f.ctx.ui.select = async () => { f.state.prompts++; return APPROVAL_CHOICES[0]; };
  await assert.rejects(request(f.cwd), /not approved/);
  assert.equal(f.state.prompts, 4);
});

test("explicit targets reject aliases, subdirectories, non-repositories and replacement during approval", async t => {
  const f = fixture(t); if (!f) return;
  f.ctx.cwd = f.workspace;
  const subdir = join(f.cwd, "subdir"); mkdirSync(subdir);
  const alias = join(f.root, "alias"); symlinkSync(f.cwd, alias);
  const empty = join(f.workspace, "empty"); mkdirSync(empty); mkdirSync(join(empty, ".git"));
  for (const repository of [alias, subdir, f.workspace, empty, "repo", `${f.cwd}/../repo`, `${f.cwd}\n`]) {
    await assert.rejects(f.request(undefined, { repository }), /canonical|repository root|control/);
  }
  assert.equal(f.state.prompts, 0);
  assert.equal(f.state.dispatches, 0);
  f.ctx.ui.select = async () => {
    const moved = join(f.root, "moved");
    renameSync(f.cwd, moved); symlinkSync(moved, f.cwd);
    return APPROVAL_CHOICES[1];
  };
  await assert.rejects(f.request(undefined, { repository: f.cwd }), /MCP approval became stale or was revoked/);
  assert.equal(f.state.dispatches, 0);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

test("fixed worker accepts a named inspection root but never redirects snapshot writes", async t => {
  const f = fixture(t); if (!f) return;
  const binary = serverIdentity("jj", [], f.root).command;
  const command = [process.execPath, fileURLToPath(new URL("../scripts/jj-checkpoint.mjs", import.meta.url))];
  // Match the launcher's pipe transport; Node uses socketpairs for spawn stdio.
  const [program, ...args] = process.platform === "linux"
    ? ["/bin/bash", "--noprofile", "--norc", "-c", LINUX_STDIO_RELAY, "checkpoint-worker-test", ...command]
    : command;
  const invoke = async data => JSON.parse(await runProcess(program, args, {
    cwd: f.workspace, env: { PI_CONFINED: "1" }, input: JSON.stringify({ binary, ...data }), timeoutMs: 10000,
  }));
  const output = await invoke({ action: "inspect", repository: f.cwd });
  assert.equal(output.result.root, f.cwd);
  assert.deepEqual(output.result.files, ["file"]);
  assert.match((await invoke({ action: "snapshot", repository: f.cwd })).error, /cannot override its disposable workspace/);
  rmSync(join(f.cwd, ".git/HEAD"));
  assert.equal((await invoke({ action: "inspect", repository: f.cwd })).error,
    "Checkpoint target is not a git repository; select its existing main root with repository, or check the selected .git directory. No host retry.");
  assert.equal(existsSync(join(f.workspace, ".git")), false);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

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

for (const phase of ["inspection", "approval"]) test(`replacing Git metadata during ${phase} prevents a checkpoint`, async t => {
  const f = fixture(t); if (!f) return;
  const replace = () => {
    renameSync(join(f.cwd, ".git"), join(f.cwd, "../original-git"));
    mkdirSync(join(f.cwd, ".git"));
  };
  if (phase === "inspection") f.state.afterInspection = replace;
  else f.ctx.ui.select = async () => { replace(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request(), /changed during (inspection|approval)/);
  assert.equal(f.state.dispatches, 0);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

test("source changes and worker failure cannot publish; session cancellation invalidates pending consent", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return; f.state.changeSource = true;
  await assert.rejects(f.request(), /source changed/); assert.equal(existsSync(join(f.cwd, ".jj")), false);
  f.state.changeSource = false; f.state.workerFailure = true;
  await assert.rejects(f.request(), /worker refused/); assert.equal(existsSync(join(f.cwd, ".jj")), false);
  f.ctx.ui.select = async () => { void f.handlers.get("session_start")(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(f.request(), /abort|cancel|stale/i); assert.equal(f.state.dispatches, 2);
});
