import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import register, { runSandboxTool, STRICT_TOOLS } from "../extensions/tool-policy/index.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-strict-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(join(agent, "scripts"), { recursive: true });
  mkdirSync(cwd);
  for (const name of ["codex-shell.mjs", "codex-tool.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
  const launcher = join(agent, "scripts/codex-shell.mjs");
  chmodSync(launcher, 0o755);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: launcher }));
  return { root, agent, cwd, launcher, worker: join(agent, "scripts/codex-tool.mjs"), sdk: join(getPackageDir(), "dist/index.js") };
}

test("routine strict calls never ask, ignore legacy exceptions, and fail closed before session load", async () => {
  const f = fixture(), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  try {
    const handlers = new Map(), tools = new Map();
    register({ on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, getActiveTools: () => [...STRICT_TOOLS] });
    const ctx = { cwd: f.cwd, isProjectTrusted: () => false, hasUI: true, ui: { confirm() { assert.fail("must never ask"); } } };
    const call = name => {
      for (const handler of handlers.get("tool_call")) {
        const result = handler({ toolName: name, input: {} }, ctx);
        if (result?.block) return result;
      }
    };
    assert.equal(call("bash").block, true);
    assert.deepEqual(handlers.get("project_trust")[0]({}), { trusted: "no" });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    writeFileSync(join(f.agent, "tool-policy.json"), '{"*":"allow"}');
    for (const name of STRICT_TOOLS) assert.equal(call(name), undefined, name);
    for (const name of ["unknown", "codemode", "remote_mcp"]) assert.equal(call(name).block, true, name);
    assert.deepEqual([...tools.keys()].sort(), ["edit", "find", "git_access", "grep", "jj_checkpoint", "ls", "model_catalog", "read", "request_build_access", "request_command_access", "request_host_access", "request_network_access", "request_podman_access", "write"]);
    ctx.isProjectTrusted = () => true;
    assert.equal(call("write").block, true, "trusted project extensions must not run on the host");
    ctx.isProjectTrusted = () => false;
    writeFileSync(join(f.agent, "settings.json"), '{"shellPath":"/bin/bash"}');
    for (const name of STRICT_TOOLS) assert.equal(call(name).block, true);
    await assert.rejects(tools.get("write").execute("id", { path: "file", content: "bad" }, undefined, undefined, ctx), /shellPath/);
    assert.equal(existsSync(join(f.cwd, "file")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native file tools run inside Codex: writes, edits, symlinks, metadata and backend failure", { timeout: 60000 }, async () => {
  const f = fixture();
  const previous = { HOME: process.env.HOME, PI_CODEX_SANDBOX_BIN: process.env.PI_CODEX_SANDBOX_BIN };
  process.env.PI_CODEX_SANDBOX_BIN = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  process.env.HOME = join(f.root, "home");
  mkdirSync(process.env.HOME);
  const call = (name, input, signal) => runSandboxTool(f.launcher, f.worker, f.sdk, f.cwd, { name, input, id: "test" }, signal);
  try {
    await call("write", { path: "nested/a.txt", content: "hello\n" });
    await call("edit", { path: "nested/a.txt", edits: [{ oldText: "hello", newText: "bonjour" }] });
    assert.match((await call("read", { path: "nested/a.txt" })).content[0].text, /bonjour/);
    await assert.rejects(call("edit", { path: "nested/a.txt", edits: [{ oldText: "absent", newText: "bad" }] }));
    assert.equal(readFileSync(join(f.cwd, "nested/a.txt"), "utf8"), "bonjour\n");
    assert.match((await call("ls", { path: "nested" })).content[0].text, /a\.txt/);
    writeFileSync(join(f.root, "outside"), "outside stays unchanged");
    symlinkSync(join(f.root, "outside"), join(f.cwd, "link"));
    for (const path of ["../outside", join(f.root, "outside"), "link", ".git/blocked", ".codex/blocked", ".agents/blocked"]) {
      if (path.startsWith(".") && path.includes("/blocked")) mkdirSync(join(f.cwd, path.split("/")[0]));
      await assert.rejects(call("write", { path, content: "bad" }), /not permitted|denied|read-only|\b(?:EACCES|EPERM|EROFS)\b/i, path);
    }
    await assert.rejects(call("edit", { path: "link", edits: [{ oldText: "outside", newText: "bad" }] }), /not permitted|denied|read-only|\b(?:EACCES|EPERM|EROFS)\b/i);
    assert.equal(readFileSync(join(f.root, "outside"), "utf8"), "outside stays unchanged");
    assert.match((await call("read", { path: "../outside" })).content[0].text, /outside stays/);
    await assert.rejects(call("write", { path: "canceled", content: "bad" }, AbortSignal.abort()), /canceled/);
    process.env.PI_CODEX_SANDBOX_BIN = join(f.root, "missing");
    await assert.rejects(call("write", { path: "unconfined", content: "bad" }));
    assert.equal(existsSync(join(f.cwd, "unconfined")), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(f.root, { recursive: true, force: true });
  }
});
