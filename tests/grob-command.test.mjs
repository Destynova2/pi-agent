import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { grobInvocation, grobProviders, grobTerminal, registerGrobCommand } from "../extensions/grob/command.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "grob-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project"), bin = join(root, "bin"), config = join(root, "config.toml");
  mkdirSync(project); mkdirSync(bin);
  writeFileSync(config, "# fixture\n");
  writeFileSync(join(bin, "grob"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "grob"), 0o700);
  return { root, project, bin, config, env: { PATH: bin, GROB_CONFIG: config } };
}

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = entries => Object.entries(entries).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  set(values);
  t.after(() => set(previous));
}

function command(t, overrides = {}) {
  environment(t, { PI_SUBAGENT_CHILD: undefined });
  const events = {}, notices = [], calls = [], choices = [];
  let registered;
  const ctx = {
    cwd: tmpdir(), hasUI: true, mode: "tui", isIdle: () => true,
    ui: {
      notify: (...args) => notices.push(args),
      select: async (title, names) => { choices.push({ title, names }); return names[0]; },
      input: async () => "anthropic",
    },
  };
  registerGrobCommand({
    registerCommand: (name, value) => { assert.equal(name, "grob"); registered = value; },
    on: (event, handler) => { events[event] = handler; },
  }, "http://127.0.0.1:13456", overrides.health ?? (async () => true), {
    providers: async () => ["anthropic", "chatgpt-codex"],
    terminal: async (_ctx, action, provider) => { calls.push({ action, provider }); return { status: 0, failed: false, signal: null }; },
    ...overrides,
  });
  return { ctx, events, notices, calls, choices, run: raw => registered.handler(raw, ctx), registered };
}

test("the prompt menu connects a selected provider and explicit reconnect stays scoped", async t => {
  const h = command(t);
  await h.run("");
  assert.deepEqual(h.calls, [{ action: "connect", provider: "anthropic" }]);
  assert.equal(h.choices.length, 2);
  assert.match(h.notices.at(-1)[0], /ne garantit pas la connexion/);
  await h.run("reconnect chatgpt-codex");
  assert.deepEqual(h.calls.at(-1), { action: "reconnect", provider: "chatgpt-codex" });
  assert.deepEqual(h.registered.getArgumentCompletions("re"), [{ value: "reconnect", label: "reconnect" }]);
});

test("cancelling either menu or the offline name prompt never launches authentication", async t => {
  const h = command(t);
  h.ctx.ui.select = async () => undefined;
  await h.run("");
  await h.run("reconnect");
  assert.deepEqual(h.calls, []);
  const offline = command(t, { providers: async () => { throw new Error("offline"); } });
  offline.ctx.ui.input = async () => undefined;
  await offline.run("connect");
  assert.deepEqual(offline.calls, []);
  offline.ctx.ui.input = async () => " chatgpt-codex ";
  await offline.run("connect");
  assert.deepEqual(offline.calls, [{ action: "connect", provider: "chatgpt-codex" }]);
});

test("status reports proxy health without triggering a login or asserting OAuth success", async t => {
  const h = command(t);
  await h.run("status");
  assert.deepEqual(h.calls, []);
  assert.match(h.notices.at(-1)[0], /anthropic, chatgpt-codex.*ne valide pas les connexions OAuth/);
  const offline = command(t, { health: async () => false });
  await offline.run("status");
  assert.match(offline.notices.at(-1)[0], /\/grob start/);
  await offline.run("start");
  assert.deepEqual(offline.calls, [{ action: "start", provider: undefined }]);
  assert.match(offline.notices.at(-1)[0], /ne répond pas/);
});

test("invalid commands and provider arguments cannot reach the CLI", async t => {
  const h = command(t);
  for (const raw of ["stop", "connect --from-system", "connect a;id", "connect $(id)", "connect ../x", "reconnect a extra", "status anthropic", "start anthropic"]) await h.run(raw);
  assert.deepEqual(h.calls, []);
  assert.equal(h.notices.length, 8);
  assert.ok(h.notices.every(([, type]) => type === "error"));
});

test("the login assistant is limited to an idle parent TUI and serialized", async t => {
  const h = command(t);
  for (const mode of ["rpc", "print", "json"]) { h.ctx.mode = mode; await h.run("connect anthropic"); }
  h.ctx.mode = "tui";
  h.ctx.hasUI = false; await h.run("connect anthropic"); h.ctx.hasUI = true;
  h.ctx.isIdle = () => false; await h.run("connect anthropic"); h.ctx.isIdle = () => true;
  process.env.PI_SUBAGENT_CHILD = "1"; await h.run("connect anthropic"); delete process.env.PI_SUBAGENT_CHILD;
  assert.deepEqual(h.calls, []);
  let release;
  h.ctx.ui.select = () => new Promise(resolve => { release = resolve; });
  const pending = h.run("");
  await h.run("connect anthropic");
  assert.deepEqual(h.calls, []);
  release(undefined);
  await pending;
  await h.run("connect anthropic");
  assert.equal(h.calls.length, 1, "cancellation releases the command lock");
});

test("switching sessions or starting generation while a menu is open cancels the pending login", async t => {
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_shutdown", "stream"]) {
    const h = command(t);
    h.ctx.ui.select = async (_title, names, { signal }) => {
      if (event === "stream") h.ctx.isIdle = () => false;
      else { h.events[event](); assert.equal(signal.aborted, true); }
      return names[0];
    };
    await h.run("reconnect");
    assert.deepEqual(h.calls, [], event);
  }
});

test("login failures do not retry or echo raw process errors into Pi", async t => {
  let attempts = 0;
  const h = command(t, { terminal: async () => { attempts++; throw new Error("fixture-private-code"); } });
  await h.run("connect anthropic");
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(h.notices).includes("fixture-private-code"), false);
  const failed = command(t, { terminal: async () => ({ status: null, signal: "SIGINT", failed: false }) });
  await failed.run("reconnect anthropic");
  assert.match(failed.notices.at(-1)[0], /interrompu/);
});

test("provider discovery sends only a fixed loopback RPC and filters untrusted names", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async request => {
    requests++;
    assert.equal(request.url, "http://127.0.0.1:13456/rpc");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("x-api-key"), "grob");
    assert.deepEqual(await request.json(), { jsonrpc: "2.0", id: "pi-providers", method: "grob/provider/list" });
    return Response.json({ result: [{ name: "chatgpt-codex" }, { name: "anthropic" }, { name: "anthropic" }, { name: "--flag" }, { name: "bad\nname" }, null] });
  });
  assert.deepEqual(await grobProviders("http://127.0.0.1:13456"), ["anthropic", "chatgpt-codex"]);
  await assert.rejects(grobProviders("https://api.openai.com"));
  assert.equal(requests, 1);
  for (const body of [{ error: { message: "private" } }, { result: {} }, { result: Array(101).fill({ name: "a" }) }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(grobProviders("http://127.0.0.1:13456"), /Catalogue Grob invalide/);
  }
});

test("CLI resolution pins an external executable and config, ignoring relative PATH entries", t => {
  const f = fixture(t);
  const invocation = grobInvocation(f.project, { ...f.env, PATH: `.:relative:${f.bin}` });
  assert.deepEqual(invocation, { binary: realpathSync(join(f.bin, "grob")), config: realpathSync(f.config), cwd: realpathSync(homedir()) });
  assert.throws(() => grobInvocation(f.project, { ...f.env, PATH: "." }), /introuvable/);
  assert.throws(() => grobInvocation(f.project, { ...f.env, GROB_CONFIG: "config.toml" }), /absolu/);
  assert.throws(() => grobInvocation(f.project, { ...f.env, GROB_CONFIG: "https://example.com/config" }), /absolu/);
  assert.throws(() => grobInvocation(f.project, { ...f.env, GROB_HOME: f.project }), /hors du projet/);
  assert.throws(() => grobInvocation(f.project, { ...f.env, GROB_HOME: f.config }), /dossier/);
});

test("project binaries and configs cannot acquire host credentials through aliases", t => {
  const f = fixture(t), evil = join(f.project, "grob"), localConfig = join(f.project, "config.toml");
  writeFileSync(evil, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(localConfig, "# project config\n");
  assert.throws(() => grobInvocation(f.project, { ...f.env, PATH: `${f.project}:${f.bin}` }), /hors du projet/);
  rmSync(join(f.bin, "grob")); symlinkSync(evil, join(f.bin, "grob"));
  assert.throws(() => grobInvocation(f.project, f.env), /hors du projet/);
  rmSync(join(f.bin, "grob")); writeFileSync(join(f.bin, "grob"), "#!/bin/sh\n", { mode: 0o700 });
  rmSync(f.config); symlinkSync(localConfig, f.config);
  assert.throws(() => grobInvocation(f.project, f.env), /hors du projet/);
});

test("terminal handoff keeps OAuth output out of capture buffers and restores Pi on success, failure and throw", async t => {
  const f = fixture(t);
  environment(t, { ...f.env, GROB_HOME: undefined, PI_SUBAGENT_CHILD: undefined });
  const events = [], launches = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (...args) => args[0] === "\x1b[2J\x1b[H" ? true : originalWrite(...args));
  const ctx = {
    cwd: f.project, hasUI: true, mode: "tui", isIdle: () => true,
    ui: { custom: async factory => {
      let result;
      await factory({ stop: () => events.push("stop"), start: () => events.push("start"), requestRender: () => events.push("render") }, {}, {}, value => { events.push("done"); result = value; });
      return result;
    } },
  };
  const execute = (binary, args, options) => {
    launches.push({ binary, args, options });
    return { status: 0, signal: null };
  };
  for (const [action, provider, expected] of [
    ["connect", "anthropic", ["connect", "anthropic"]],
    ["reconnect", "chatgpt-codex", ["connect", "chatgpt-codex", "--force-reauth"]],
    ["start", undefined, ["start", "-d"]],
  ]) {
    assert.deepEqual(await grobTerminal(ctx, action, provider, execute), { status: 0, signal: null, failed: false });
    const launch = launches.at(-1);
    assert.deepEqual(launch.args, ["--config", realpathSync(f.config), ...expected]);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.stdio, "inherit");
    assert.equal(launch.options.cwd, realpathSync(homedir()));
    assert.equal(launch.options.timeout, 600_000);
    assert.deepEqual(events.splice(0), ["stop", "start", "render", "done"]);
  }
  const interrupted = await grobTerminal(ctx, "connect", "anthropic", () => ({ status: null, signal: "SIGTERM", error: new Error("timeout") }));
  assert.deepEqual(interrupted, { status: null, signal: "SIGTERM", failed: true });
  assert.deepEqual(events.splice(0), ["stop", "start", "render", "done"]);
  assert.deepEqual(await grobTerminal(ctx, "connect", "anthropic", () => { throw new Error("fixture failure"); }), { status: null, signal: null, failed: true });
  assert.deepEqual(events.splice(0), ["stop", "start", "render", "done"]);
  for (const [action, provider] of [["stop", undefined], ["reconnect", undefined], ["start", "anthropic"], ["connect", "--from-system"]]) {
    await assert.rejects(grobTerminal(ctx, action, provider, execute), /invalide/);
  }
  ctx.mode = "rpc";
  await assert.rejects(grobTerminal(ctx, "connect", "anthropic", execute), /interactif/);
  assert.equal(launches.length, 3);
});
