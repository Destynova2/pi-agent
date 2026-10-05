// Operator gate: requires a host able to create Codex's sandbox. Never substitutes a host Git retry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerGitAccess } from "../extensions/tool-policy/git-access.ts";
import { runProcess } from "../lib/process.ts";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("real Codex Git consent grants only Git data; hooks run confined and ordinary Bash stays unchanged", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-access-jail-"))), agent = join(root, "agent"), cwd = join(root, "repo"), home = join(root, "home");
  for (const path of [agent, cwd, home]) mkdirSync(path);
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "PI_CODEX_NETWORK_GRANTS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: codex, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }); delete process.env.PI_CODEX_NETWORK_GRANTS;
  const handlers = new Map(); let tool, prompts = 0;
  try {
    for (const path of ["scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/metal-backend.mjs", "scripts/git-operation.mjs", "scripts/git-hook-guard.mjs", ...["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"].map(name => `scripts/git-hooks/${name}`), "extensions/tool-policy/git-access-core.ts", "lib/process.ts"]) {
      const target = join(agent, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(new URL(`../${path}`, import.meta.url), target);
    }
    // Only this synthetic repository has raw fixture diagnostics. Production
    // workers continue withholding hooks/remote output that may contain secrets.
    const worker = join(agent, "scripts/git-operation.mjs");
    writeFileSync(worker, readFileSync(worker, "utf8").replace('lead ?? "Git operation failed; raw helper output withheld"', 'message'));
    const launcher = join(agent, "scripts/codex-shell.mjs"); chmodSync(launcher, 0o755);
    writeFileSync(join(agent, "network-policy.json"), '{"allow":[]}'); writeFileSync(join(agent, "settings.json"), "{}");
    const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
    const config = readFileSync(join(cwd, ".git/config"), "utf8");
    writeFileSync(join(cwd, "file"), "one\n"); writeFileSync(join(root, "outside"), "unchanged");
    const options = { cwd, timeoutMs: 30000, maxBytes: 1024 * 1024 };
    const ordinary = () => runProcess(launcher, ["-c", "/usr/bin/git add -- file"], options);
    await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { prompts++; return choices[3]; }, notify() {} } };
    registerGitAccess({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: definition => { tool = definition; }, getActiveTools: () => ["git_access"] }, agent, () => {});
    const request = input => tool.execute("test", { reason: "isolated fixture only", ...input }, undefined, undefined, ctx);
    await request({ operation: "stage", paths: ["file"] });
    writeFileSync(join(cwd, "hook.mjs"), `import assert from 'node:assert/strict'; import fs from 'node:fs';
for (const path of ${JSON.stringify([join(root, "outside"), join(agent, "settings.json"), join(cwd, ".git/config"), join(cwd, ".git/hooks/blocked")])}) assert.throws(() => fs.writeFileSync(path, 'bad'), /EPERM|EACCES|EROFS/);
fs.writeFileSync('hook-proof', 'confined');\n`);
    writeFileSync(join(cwd, ".git/hooks/pre-commit"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(cwd, "hook.mjs"))}\n`, { mode: 0o755 });
    await request({ operation: "commit", paths: ["file"], message: "fix: isolated sandbox fixture" });
    await request({ operation: "branch", branch: "fix/fixture" });
    assert.equal(prompts, 1); assert.equal(readFileSync(join(cwd, "hook-proof"), "utf8"), "confined");
    assert.equal(readFileSync(join(cwd, ".git/config"), "utf8"), config); assert.equal(readFileSync(join(root, "outside"), "utf8"), "unchanged");
    writeFileSync(join(cwd, "file"), "two\n"); await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    process.env.PI_CODEX_SANDBOX_BIN = join(root, "missing");
    await assert.rejects(request({ operation: "stage", paths: ["file"] }));
    assert.equal(git("diff", "--cached", "--name-only").trim(), "");
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
