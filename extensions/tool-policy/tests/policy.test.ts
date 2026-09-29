import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_TOOL_POLICY, loadToolPolicy, MAX_POLICY_BYTES, protectedPathViolation, toolDecision } from "../core.ts";
import extension from "../index.ts";

function tempDir(policy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-policy-"));
  if (policy !== undefined) writeFileSync(join(dir, "tool-policy.json"), policy);
  return dir;
}

type Handler = (event: any, ctx: any) => Promise<any>;
function load(dir: string) {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let handler: Handler | undefined;
  let command: any;
  try {
    extension({
      on: (name: string, h: Handler) => { if (name === "tool_call") handler = h; },
      registerCommand: (name: string, c: any) => { if (name === "tool-policy") command = c; },
    } as any);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  }
  assert.ok(handler && command);
  return { handler: handler!, command };
}

function ui(confirm: (...args: any[]) => Promise<boolean>, signal?: AbortSignal, hasUI = true, cwd = tmpdir()) {
  const calls: any[][] = [];
  const notes: [string, string][] = [];
  return {
    calls, notes,
    ctx: {
      hasUI, signal, cwd,
      ui: { confirm: (...args: any[]) => { calls.push(args); return confirm(...args); }, notify: (m: string, t: string) => notes.push([m, t]) },
    },
  };
}
const call = (toolName: string, input: Record<string, unknown> = {}) => ({ type: "tool_call", toolCallId: "id", toolName, input });
const tick = () => new Promise((r) => setImmediate(r));

test("built-in policy when file absent, immutable, exact lookup", () => {
  const dir = tempDir();
  try {
    const policy = loadToolPolicy(dir);
    assert.equal(policy, DEFAULT_TOOL_POLICY);
    for (const name of ["read", "grep", "find", "ls", "edit", "write", "note_list", "note_add", "project_graph", "git_inspect", "subagent"]) assert.equal(toolDecision(policy, name), "allow");
    assert.equal(toolDecision(policy, "bash"), "ask");
    assert.equal(toolDecision(policy, "*"), "ask");
    assert.equal(toolDecision(policy, "toString"), "ask");
    assert.equal(toolDecision(policy, "__proto__"), "ask");
    assert.equal(toolDecision(policy, "READ"), "ask");
    assert.ok(Object.isFrozen(policy));
    assert.throws(() => { (policy as any).bash = "allow"; }, TypeError);
  } finally { rmSync(dir, { recursive: true }); }
});

test("existing file fully replaces built-in; absent * means ask", () => {
  const a = tempDir('{"bash":"allow","read":"deny"}');
  const b = tempDir('{"*":"deny","ls":"ask"}');
  try {
    const p = loadToolPolicy(a);
    assert.equal(toolDecision(p, "bash"), "allow");
    assert.equal(toolDecision(p, "read"), "deny");
    assert.equal(toolDecision(p, "edit"), "ask");
    assert.equal(toolDecision(p, "*"), "ask");
    assert.ok(Object.isFrozen(p));
    const q = loadToolPolicy(b);
    assert.equal(toolDecision(q, "ls"), "ask");
    assert.equal(toolDecision(q, "write"), "deny");
    assert.equal(toolDecision(q, "hasOwnProperty"), "deny");
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test("malformed, prototype-key, symlinked, oversized, non-file policies are rejected loudly", () => {
  const bad = ["{", "[]", "null", '"allow"', '{"read":"yes"}', '{"read":1}', '{"":"allow"}', '{"bad name":"allow"}',
    '{"__proto__":"allow"}', '{"constructor":"allow"}', '{"prototype":"deny"}', " ".repeat(MAX_POLICY_BYTES + 1)];
  for (const text of bad) {
    const dir = tempDir(text);
    try { assert.throws(() => loadToolPolicy(dir), /tool-policy\.json/, text.slice(0, 30)); } finally { rmSync(dir, { recursive: true }); }
  }
  const link = tempDir();
  const target = join(link, "real.json");
  writeFileSync(target, '{"*":"allow"}');
  symlinkSync(target, join(link, "tool-policy.json"));
  const folder = tempDir();
  mkdirSync(join(folder, "tool-policy.json"));
  try {
    assert.throws(() => loadToolPolicy(link), /symlink/);
    assert.throws(() => loadToolPolicy(folder), /tool-policy\.json/);
    assert.throws(() => loadToolPolicy(""), /agent directory/);
  } finally { rmSync(link, { recursive: true }); rmSync(folder, { recursive: true }); }
});

test("corrupt policy: factory does not throw, every tool blocked, command reports error", async () => {
  const dir = tempDir("{not json");
  try {
    const { handler, command } = load(dir);
    const u = ui(async () => true);
    for (const name of ["read", "bash", "subagent"]) {
      const r = await handler(call(name), u.ctx);
      assert.equal(r?.block, true);
      assert.match(r.reason, /failed to load/);
    }
    assert.equal(u.calls.length, 0);
    await command.handler("", u.ctx);
    assert.equal(u.notes[0][1], "error");
    assert.match(u.notes[0][0], /invalid JSON/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("allow passes and deep-freezes input; deny blocks; invalid name blocks; command reports", async () => {
  const dir = tempDir('{"read":"allow","bash":"deny"}');
  try {
    const { handler, command } = load(dir);
    const u = ui(async () => true);
    const event = call("read", { path: "a", nested: { list: [1] } });
    assert.equal(await handler(event, u.ctx), undefined);
    assert.throws(() => { (event.input.nested as any).list.push(2); }, TypeError);
    assert.throws(() => { (event.input as any).path = "/etc/shadow"; }, TypeError);
    const denied = await handler(call("bash", { command: "ls" }), u.ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /denied/);
    assert.equal((await handler(call("__proto__"), u.ctx)).block, true);
    assert.equal((await handler(call("x y"), u.ctx)).block, true);
    const typed = await handler(call("read", { data: new Uint8Array(2) }), u.ctx);
    assert.equal(typed.block, true);
    assert.equal(u.calls.length, 0);
    await command.handler("", u.ctx);
    assert.equal(u.notes[0][1], "info");
    assert.match(u.notes[0][0], /bash: deny/);
    assert.match(u.notes[0][0], /\*: ask/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("ask: headless denied, UI yes/no/error/abort", async () => {
  const dir = tempDir();
  try {
    const { handler } = load(dir);
    const headless = ui(async () => true, undefined, false);
    assert.equal((await handler(call("bash"), headless.ctx)).block, true);
    assert.equal(headless.calls.length, 0);

    assert.equal(await handler(call("bash", { command: "ls" }), ui(async () => true).ctx), undefined);
    assert.equal((await handler(call("bash"), ui(async () => false).ctx)).block, true);
    assert.equal((await handler(call("bash"), ui(async () => { throw new Error("rpc down"); }).ctx)).block, true);
    assert.equal((await handler(call("bash"), ui(async () => "yes" as any).ctx)).block, true);

    const pre = new AbortController(); pre.abort();
    const preUi = ui(async () => true, pre.signal);
    assert.equal((await handler(call("bash"), preUi.ctx)).block, true);
    assert.equal(preUi.calls.length, 0);

    const controller = new AbortController();
    const hanging = ui(() => new Promise<boolean>(() => {}), controller.signal);
    const pending = handler(call("bash"), hanging.ctx);
    await tick();
    assert.equal(hanging.calls.length, 1);
    assert.equal(hanging.calls[0][2].signal, controller.signal);
    controller.abort();
    assert.equal((await pending).block, true);

    // approved answer arriving after abort still denies
    const late = new AbortController();
    const lateUi = ui(async () => { late.abort(); return true; }, late.signal);
    assert.equal((await handler(call("bash"), lateUi.ctx)).block, true);
  } finally { rmSync(dir, { recursive: true }); }
});

test("simultaneous asks are serialized; queued ask after abort never prompts", async () => {
  const dir = tempDir();
  try {
    const { handler } = load(dir);
    const resolvers: ((v: boolean) => void)[] = [];
    const u = ui(() => new Promise<boolean>((r) => resolvers.push(r)));
    const first = handler(call("bash", { n: 1 }), u.ctx);
    const second = handler(call("web_fetch", { n: 2 }), u.ctx);
    await tick();
    assert.equal(u.calls.length, 1);
    resolvers[0](true);
    assert.equal(await first, undefined);
    await tick();
    assert.equal(u.calls.length, 2);
    assert.match(u.calls[1][0], /web_fetch/);
    resolvers[1](false);
    assert.equal((await second).block, true);

    const controller = new AbortController();
    const v = ui(() => new Promise<boolean>(() => {}), controller.signal);
    const a = handler(call("bash"), v.ctx);
    const b = handler(call("bash"), v.ctx);
    await tick();
    assert.equal(v.calls.length, 1);
    controller.abort();
    assert.equal((await a).block, true);
    assert.equal((await b).block, true);
    assert.equal(v.calls.length, 1);

    // queue recovers for a fresh turn
    assert.equal(await handler(call("bash"), ui(async () => true).ctx), undefined);
  } finally { rmSync(dir, { recursive: true }); }
});

test("FIFO policy file is rejected without blocking", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  try {
    const made = spawnSync("mkfifo", [join(dir, "tool-policy.json")]);
    if (made.error || made.status !== 0) throw new Error("mkfifo unavailable");
    assert.throws(() => loadToolPolicy(dir), /not a regular file/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("edit/write never touch the agent directory, whatever the rule", async () => {
  const agent = tempDir('{"*":"allow"}');
  const work = realpathSync(tempDir());
  try {
    mkdirSync(join(agent, "agents"));
    symlinkSync(agent, join(work, "link"));
    symlinkSync(join(agent, "nope", "x.json"), join(work, "dangling"));
    const blocked = [
      join(agent, "tool-policy.json"), join(agent, "agents", "new.md"), join(agent, "missing", "deep", "f.ts"),
      `@${agent}/tool-policy.json`, `file://${agent}/tool-policy.json`, join(relative(work, agent), "a"),
      "link/tool-policy.json", "link/extensions/new/index.ts", "dangling",
      "", "   ", 42, undefined, "a\0b", join(work, "file.txt", "under-a-file"),
    ];
    writeFileSync(join(work, "file.txt"), "x");
    for (const path of blocked) assert.ok(protectedPathViolation(agent, path, work), String(path));
    assert.match(protectedPathViolation(agent, "link/tool-policy.json", work)!, /protected agent directory/);
    for (const path of ["file.txt", "new/dir/x.ts", join(work, "y"), `${agent}-sibling/x`]) assert.equal(protectedPathViolation(agent, path, work), undefined, path);
    assert.ok(protectedPathViolation(agent, "x", undefined));

    const { handler } = load(agent);
    const u = ui(async () => true, undefined, true, work);
    for (const tool of ["edit", "write"]) {
      const r = await handler(call(tool, { path: "link/tool-policy.json", content: "{}" }), u.ctx);
      assert.equal(r?.block, true);
      assert.match(r.reason, /protected agent directory/);
      assert.equal((await handler(call(tool, {}), u.ctx))?.block, true);
      assert.equal(await handler(call(tool, { path: "file.txt", content: "ok" }), u.ctx), undefined);
    }
    // other tools are not path-classified (not a sandbox)
    assert.equal(await handler(call("read", { path: join(agent, "tool-policy.json") }), u.ctx), undefined);
    const noCwd = ui(async () => true, undefined, true, undefined as any);
    delete (noCwd.ctx as any).cwd;
    assert.equal((await handler(call("write", { path: "file.txt" }), noCwd.ctx))?.block, true);
    assert.equal(u.calls.length, 0);
  } finally { rmSync(agent, { recursive: true }); rmSync(work, { recursive: true }); }
});

test("already-aborted turn blocks even allowed tools", async () => {
  const dir = tempDir('{"*":"allow"}');
  try {
    const { handler } = load(dir);
    const c = new AbortController(); c.abort();
    const r = await handler(call("read", { path: "x" }), ui(async () => true, c.signal).ctx);
    assert.equal(r?.block, true);
    assert.match(r.reason, /aborted/);
  } finally { rmSync(dir, { recursive: true }); }
});
