import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerJjCheckpoint } from "../extensions/tool-policy/jj-checkpoint.ts";
import { runProcess } from "../lib/process.ts";
import { sandboxBackend } from "../scripts/codex-shell.mjs";

for (const initializedGit of [true, false]) test(`native checkpoint initializes and snapshots in Codex without granting ordinary Bash Git access (initialized Git: ${initializedGit})`, { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-checkpoint-jail-"))), agent = join(root, "agent"), cwd = join(root, "repo"), home = join(root, "home");
  for (const path of [agent, cwd, home]) mkdirSync(path);
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG", "XDG_CONFIG_HOME"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), backend = realpathSync(sandboxBackend());
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: backend, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(agent, "host-config") });
  delete process.env.JJ_CONFIG;
  const userConfig = join(process.env.XDG_CONFIG_HOME, "jj/config.toml"), userSettings = '[user]\nname="Fixture"\nemail="fixture@example.com"\n';
  mkdirSync(dirname(userConfig), { recursive: true }); writeFileSync(userConfig, userSettings);
  const globalIgnore = join(process.env.XDG_CONFIG_HOME, "git/ignore");
  mkdirSync(dirname(globalIgnore)); writeFileSync(globalIgnore, "private-ignored\n");
  const handlers = new Map(); let tool;
  try {
    for (const file of ["scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/metal-backend.mjs", "scripts/jj-checkpoint.mjs", "lib/jj-checkpoint.ts", "lib/process.ts"]) {
      const target = join(agent, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(new URL(`../${file}`, import.meta.url), target);
    }
    const launcher = join(agent, "scripts/codex-shell.mjs"); chmodSync(launcher, 0o755);
    writeFileSync(join(agent, "settings.json"), "{}"); writeFileSync(join(agent, "network-policy.json"), '{"allow":[]}');
    if (initializedGit) execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    else mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, "file"), "before\n");
    writeFileSync(join(cwd, "private-ignored"), "excluded by the user's XDG Git ignore file\n");
    if (initializedGit) {
      // jj-vcs/jj#8841: a remote default branch makes init write secure config.
      const git = args => execFileSync("/usr/bin/git", args, { cwd, stdio: "ignore" });
      git(["add", "file"]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      writeFileSync(join(cwd, "file"), "staged\n"); git(["add", "file"]);
      writeFileSync(join(cwd, "file"), "before\n");
    }
    const config = initializedGit ? readFileSync(join(cwd, ".git/config")) : undefined;
    const index = initializedGit ? readFileSync(join(cwd, ".git/index")) : undefined;
    // Fail on a missing host sandbox before checking an expected Git denial.
    await runProcess(launcher, ["--offline", "-c", "true"], { cwd, timeoutMs: 15000 });
    await assert.rejects(runProcess(launcher, ["--offline", "-c", 'mkdir "$XDG_CONFIG_HOME/jj/repos"'], { cwd, timeoutMs: 15000 }), /denied|not permitted|read-only/i);
    const ordinary = () => runProcess(launcher, ["--offline", "-c", "/usr/bin/git add -- file"], { cwd, timeoutMs: 15000 });
    if (initializedGit) await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    registerJjCheckpoint({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: value => { tool = value; }, getActiveTools: () => ["jj_checkpoint"] }, agent, () => {});
    const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => choices[1], notify() {} } };
    const first = JSON.parse((await tool.execute("test", { reason: "isolated fixture" }, undefined, undefined, ctx)).content[0].text);
    assert.equal(first.initialized, true); assert.match(first.commitId, /^[a-f0-9]{40,64}$/);
    writeFileSync(join(cwd, "file"), "next\n");
    const second = JSON.parse((await tool.execute("test", { reason: "next task" }, undefined, undefined, ctx)).content[0].text);
    assert.equal(second.initialized, false); assert.notEqual(second.operationId, first.operationId);
    if (config) assert.deepEqual(readFileSync(join(cwd, ".git/config")), config);
    if (index) assert.deepEqual(readFileSync(join(cwd, ".git/index")), index);
    assert.equal(readFileSync(userConfig, "utf8"), userSettings);
    assert.equal(readFileSync(globalIgnore, "utf8"), "private-ignored\n");
    assert.equal(existsSync(join(process.env.XDG_CONFIG_HOME, "jj/repos")), false);
    assert.equal(existsSync(join(cwd, ".jj/repo/config-id")), false);
    assert.equal(execFileSync("/usr/bin/git", ["show", "-s", "--format=%cn <%ce>", second.gitRef], { cwd, encoding: "utf8" }).trim(), "Fixture <fixture@example.com>");
    assert.equal(execFileSync("/usr/bin/git", ["ls-tree", "-r", "--name-only", second.gitRef], { cwd, encoding: "utf8" }).trim(), "file");
    assert.equal(readFileSync(join(cwd, "file"), "utf8"), "next\n");
    await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
