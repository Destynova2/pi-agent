import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerJjCheckpoint } from "../extensions/tool-policy/jj-checkpoint.ts";
import { runProcess } from "../lib/process.ts";
import { sandboxBackend } from "../scripts/codex-shell.mjs";

test("native checkpoint initializes and snapshots in Codex without granting ordinary Bash Git access", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-checkpoint-jail-"))), agent = join(root, "agent"), cwd = join(root, "repo"), home = join(root, "home");
  for (const path of [agent, cwd, home]) mkdirSync(path);
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), backend = realpathSync(sandboxBackend());
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: backend, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: join(home, "jj.toml") });
  writeFileSync(process.env.JJ_CONFIG, '[user]\nname="Fixture"\nemail="fixture@example.com"\n');
  const handlers = new Map(); let tool;
  try {
    for (const file of ["scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/metal-backend.mjs", "scripts/jj-checkpoint.mjs", "lib/jj-checkpoint.ts", "lib/process.ts"]) {
      const target = join(agent, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(new URL(`../${file}`, import.meta.url), target);
    }
    const launcher = join(agent, "scripts/codex-shell.mjs"); chmodSync(launcher, 0o755);
    writeFileSync(join(agent, "settings.json"), "{}"); writeFileSync(join(agent, "network-policy.json"), '{"allow":[]}');
    execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd, stdio: "ignore" }); writeFileSync(join(cwd, "file"), "before\n");
    const config = readFileSync(join(cwd, ".git/config"));
    // Fail on a missing host sandbox before checking an expected Git denial.
    await runProcess(launcher, ["--offline", "-c", "true"], { cwd, timeoutMs: 15000 });
    const ordinary = () => runProcess(launcher, ["--offline", "-c", "/usr/bin/git add -- file"], { cwd, timeoutMs: 15000 });
    await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    registerJjCheckpoint({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: value => { tool = value; }, getActiveTools: () => ["jj_checkpoint"] }, agent, () => {});
    const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => choices[1], notify() {} } };
    const first = JSON.parse((await tool.execute("test", { reason: "isolated fixture" }, undefined, undefined, ctx)).content[0].text);
    assert.equal(first.initialized, true); assert.match(first.commitId, /^[a-f0-9]{40,64}$/);
    writeFileSync(join(cwd, "file"), "next\n");
    const second = JSON.parse((await tool.execute("test", { reason: "next task" }, undefined, undefined, ctx)).content[0].text);
    assert.equal(second.initialized, false); assert.notEqual(second.operationId, first.operationId);
    assert.deepEqual(readFileSync(join(cwd, ".git/config")), config); assert.equal(readFileSync(join(cwd, "file"), "utf8"), "next\n");
    await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
