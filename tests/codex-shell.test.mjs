import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxArgs } from "../scripts/codex-shell.mjs";
import register from "../extensions/codex-sandbox/index.ts";

test("sandbox arguments preserve the entire shell program as one argument and never grant escalation", () => {
  const command = 'printf "%s" "quoted text"; false\nprintf done';
  const args = sandboxArgs(command);
  assert.equal(args.at(-1), command);
  assert.deepEqual(args.slice(-6), ["--", "/bin/bash", "--noprofile", "--norc", "-c", command]);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes("sandbox_workspace_write={writable_roots=[],network_access=false,exclude_tmpdir_env_var=false,exclude_slash_tmp=true}"));
});

test("sandbox guard rejects project shell overrides and stale sessions, including before reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-guard-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const agent = process.env.PI_CODING_AGENT_DIR;
    const cwd = join(root, "project");
    mkdirSync(join(agent, "scripts"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const launcher = join(agent, "scripts/codex-shell.mjs");
    writeFileSync(launcher, "");
    writeFileSync(join(agent, "settings.json"), "{}");
    const handlers = new Map();
    register({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
    const ctx = { cwd, isProjectTrusted: () => true };
    const call = () => handlers.get("tool_call")({ toolName: "bash" }, ctx);
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined, "adapter is opt-in");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: launcher }));
    assert.equal((await call()).block, true, "disk change alone does not configure a cached shell");
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined);
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
    assert.equal((await call()).block, true);
    await handlers.get("session_start")({}, ctx);
    rmSync(join(cwd, ".pi/settings.json"));
    assert.equal((await call()).block, true, "removing an override also needs reload");
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined);
    assert.equal(await handlers.get("tool_call")({ toolName: "read" }, ctx), undefined);
    const inside = join(cwd, "child");
    const outside = join(root, "other-project");
    mkdirSync(inside); mkdirSync(outside);
    symlinkSync(outside, join(cwd, "escape"));
    const delegate = input => handlers.get("tool_call")({ toolName: "subagent", input }, ctx);
    assert.equal(await delegate({ cwd: inside }), undefined);
    for (const input of [{ cwd: outside }, { tasks: [{ cwd: outside }] }, { chain: [{ cwd: outside }] }, { cwd: join(cwd, "escape") }]) {
      assert.equal((await delegate(input)).block, true, "delegation cannot broaden the sandbox by changing cwd");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
