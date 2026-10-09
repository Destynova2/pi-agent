// Native boundary gate: no host fallback for the approved worker or its hooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerGitInit } from "../extensions/tool-policy/git-init.ts";
import { registerGitAccess } from "../extensions/tool-policy/git-access.ts";
import { runtimeRoot } from "../lib/runtime-paths.mjs";
import { runProcess } from "../lib/process.ts";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("native initialization publishes only a fresh empty root and repository selection preserves the original jail", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-init-jail-")));
  const agent = join(root, "agent"), cwd = join(root, "source"), repository = join(root, "repository"), home = join(root, "home"), template = join(root, "template");
  for (const path of [agent, cwd, repository, home, join(template, "hooks")]) mkdirSync(path, { recursive: true });
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "PI_CODEX_NETWORK_GRANTS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TEMPLATE_DIR"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: codex, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: template });
  delete process.env.PI_CODEX_NETWORK_GRANTS;
  const handlers = [], tools = new Map(); let prompts = 0;
  try {
    for (const path of ["scripts/git-init.mjs", "scripts/git-hook-guard.mjs", "lib/git-init.ts", "lib/git-command.ts", "lib/process.ts", ...["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"].map(name => `scripts/git-hooks/${name}`)]) {
      const target = join(agent, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(runtimeRoot, path), target);
    }
    // Raw diagnostics only in this isolated fixture; production redacts helpers.
    const worker = join(agent, "scripts/git-init.mjs");
    writeFileSync(worker, readFileSync(worker, "utf8").replace("} catch {", "} catch (failure) {").replace('error: "Git initialization failed', 'error: failure.message + " Git initialization failed'));
    writeFileSync(join(agent, "settings.json"), "{}"); writeFileSync(join(agent, "network-policy.json"), '{"allow":[]}');
    for (const path of [join(root, "outside"), join(repository, "file"), join(cwd, "source-file")]) writeFileSync(path, "unchanged\n");
    const hook = join(root, "hook.mjs");
    writeFileSync(hook, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
for (const target of ${JSON.stringify([join(root, "outside"), join(agent, "settings.json"), join(repository, "file"), join(repository, ".git/config")])}) assert.throws(() => fs.writeFileSync(target, 'bad'), /EPERM|EACCES|EROFS|ENOENT/);
if (process.env.PI_GIT_ACCESS_EXPECTED_HEAD === '') {
  assert.throws(() => fs.writeFileSync(${JSON.stringify(join(cwd, "source-file"))}, 'bad'), /EPERM|EACCES|EROFS/);
  fs.writeFileSync(path.join(process.env.GIT_DIR, 'description'), 'hooks stayed confined\\n');
}
`);
    writeFileSync(join(template, "hooks/pre-commit"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hook)}\n`, { mode: 0o755 });
    const api = { on: (name, handler) => { if (name === "session_shutdown") handlers.push(handler); }, registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), getActiveTools: () => [...tools.keys()] };
    registerGitInit(api, agent, () => {}, (launcher, args, options) => runProcess(launcher, [...args.slice(0, -1), [process.execPath, worker].map(quote).join(" ")], options));
    registerGitAccess(api, agent, () => {});
    const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { if (choices.includes("Lire la page suivante")) return "Lire la page suivante"; prompts++; return choices[1]; }, notify() {} } };
    const request = { repository, branch: "main", remote: "origin", url: "https://example.com/project.git", author_name: "Fixture", author_email: "fixture@example.com", message: "chore: initialize repository", reason: "isolated boundary fixture" };
    const result = await tools.get("git_repository_init").execute("init", request, undefined, undefined, ctx);
    const head = JSON.parse(result.content[0].text).head;
    const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.equal(git("rev-list", "--parents", "main"), head);
    assert.equal(git("ls-tree", "-r", "main"), "");
    assert.equal(git("status", "--porcelain"), "?? file");
    assert.equal(readFileSync(join(repository, ".git/description"), "utf8"), "hooks stayed confined\n");
    assert.doesNotMatch(readFileSync(join(repository, ".git/config"), "utf8"), /worktree|pi-git-init-/);
    const access = input => tools.get("git_access").execute("access", { ...input, repository, reason: "isolated boundary fixture" }, undefined, undefined, ctx);
    await access({ operation: "branch", branch: "develop" });
    await access({ operation: "stage", paths: ["file"] });
    await access({ operation: "commit", paths: ["file"], message: "feat: add reviewed content" });
    assert.equal(git("rev-parse", "develop^"), head);
    assert.equal(git("ls-tree", "-r", "main"), "");
    assert.equal(prompts, 4);
    for (const path of [join(root, "outside"), join(repository, "file"), join(cwd, "source-file")]) assert.equal(readFileSync(path, "utf8"), "unchanged\n");
    const launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
    await assert.rejects(runProcess(launcher, ["-c", `/usr/bin/git -C ${quote(repository)} add -- file`], { cwd, timeoutMs: 30000 }), /denied|not permitted|read-only/i);
    await assert.rejects(tools.get("git_repository_init").execute("repeat", request, undefined, undefined, ctx), /already has repository/);
    assert.equal(existsSync(join(cwd, ".git")), false);
  } finally {
    for (const handler of handlers) await handler();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
