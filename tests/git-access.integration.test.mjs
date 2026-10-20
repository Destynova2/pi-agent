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
    for (const path of ["scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/metal-backend.mjs", "scripts/git-operation.mjs", "scripts/git-hook-guard.mjs", ...["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"].map(name => `scripts/git-hooks/${name}`), "extensions/tool-policy/git-access-core.ts", "lib/git-command.ts", "lib/process.ts"]) {
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
    // Checkpoints can leave this blob in the source pool with another encoding.
    const oid = git("-c", "core.compression=0", "hash-object", "-w", "--", "file").trim();
    const object = join(cwd, ".git/objects", oid.slice(0, 2), oid.slice(2)), compressed = readFileSync(object);
    const options = { cwd, timeoutMs: 30000, maxBytes: 1024 * 1024 };
    const ordinary = () => runProcess(launcher, ["-c", "/usr/bin/git add -- file"], options);
    await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => { if (choices.includes("Lire la page suivante")) return "Lire la page suivante"; prompts++; return choices[3]; }, notify() {} } };
    registerGitAccess({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: definition => { tool = definition; }, getActiveTools: () => ["git_access"] }, agent, () => {});
    const request = input => tool.execute("test", { reason: "isolated fixture only", ...input }, undefined, undefined, ctx);
    await request({ operation: "stage", paths: ["file"] });
    assert.deepEqual(readFileSync(object), compressed, "staging must preserve an equivalent existing object");
    writeFileSync(join(cwd, "hook.mjs"), `import assert from 'node:assert/strict'; import fs from 'node:fs';
for (const path of ${JSON.stringify([join(root, "outside"), join(agent, "settings.json"), join(cwd, ".git/config"), join(cwd, ".git/hooks/blocked")])}) assert.throws(() => fs.writeFileSync(path, 'bad'), /EPERM|EACCES|EROFS/);
if (process.env.GIT_COMMON_DIR) {
  for (const suffix of ['/config', '/hooks/blocked']) assert.throws(() => fs.writeFileSync(process.env.GIT_COMMON_DIR + suffix, 'bad'), /EPERM|EACCES|EROFS/);
}
fs.writeFileSync('hook-proof', 'confined');\n`);
    writeFileSync(join(cwd, ".git/hooks/pre-commit"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(cwd, "hook.mjs"))}\n`, { mode: 0o755 });
    await request({ operation: "commit", paths: ["file"], message: "fix: isolated sandbox fixture" });
    await request({ operation: "branch", branch: "fix/fixture" });
    assert.equal(prompts, 1); assert.equal(readFileSync(join(cwd, "hook-proof"), "utf8"), "confined");
    assert.equal(readFileSync(join(cwd, ".git/config"), "utf8"), config); assert.equal(readFileSync(join(root, "outside"), "utf8"), "unchanged");
    writeFileSync(join(cwd, "file"), "two\n"); await assert.rejects(ordinary(), /denied|not permitted|read-only/i);
    const linked = join(root, "linked");
    git("worktree", "add", "-b", "fix/linked", linked);
    ctx.cwd = linked;
    writeFileSync(join(linked, "file"), "linked\n");
    await request({ operation: "stage", paths: ["file"] });
    await request({ operation: "commit", paths: ["file"], message: "fix: linked sandbox fixture" });
    assert.equal(execFileSync("/usr/bin/git", ["show", "HEAD:file"], { cwd: linked, encoding: "utf8" }), "linked\n");
    assert.equal(git("diff", "--cached", "--name-only").trim(), "", "linked index never changes the other worktree");
    ctx.cwd = cwd;
    const many = Array.from({ length: 160 }, (_, i) => `owned-${i}.txt`);
    for (const path of many) writeFileSync(join(cwd, path), path + "\n");
    writeFileSync(join(cwd, "another-session"), "leave untracked\n");
    await request({ operation: "stage", paths: many });
    await request({ operation: "commit", paths: many, message: "fix: commit explicit large fixture" });
    assert.equal(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split("\n").length, 160);
    assert.equal(git("ls-files", "--", "another-session").trim(), "");
    // Update a sibling worktree without widening the parent session's ordinary tools.
    const linkedGit = (...args) => execFileSync("/usr/bin/git", args, { cwd: linked, encoding: "utf8" }).trim();
    linkedGit("switch", "-c", "incoming");
    writeFileSync(join(linked, "remote-update"), "fetched content\n");
    ctx.cwd = linked;
    await request({ operation: "stage", paths: ["remote-update"] });
    await request({ operation: "commit", paths: ["remote-update"], message: "fix: upstream fixture" });
    ctx.cwd = cwd;
    const fetched = linkedGit("rev-parse", "HEAD");
    linkedGit("update-ref", "refs/remotes/origin/main", fetched); linkedGit("switch", "fix/linked");
    writeFileSync(join(linked, "unrelated-local"), "preserve\n");
    for (const name of [".agents", ".codex", ".pi"]) { mkdirSync(join(linked, name)); writeFileSync(join(linked, name, "protected"), "unchanged"); }
    writeFileSync(join(cwd, ".git/hooks/post-merge"), `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(`const fs=require('fs'),assert=require('assert/strict'); for(const path of ${JSON.stringify([join(root, "outside"), join(cwd, ".git/config"), join(linked, ".agents/protected"), join(linked, ".codex/protected"), join(linked, ".pi/protected")])}) assert.throws(()=>fs.writeFileSync(path,'escape'),/EPERM|EACCES|EROFS/); fs.writeFileSync('merge-proof','confined');`)}\n`, { mode: 0o755 });
    ctx.model = { provider: "fixture", id: "reviewer" };
    ctx.sessionManager = { getBranch: () => [{ type: "message", message: { role: "user", content: "Update the sibling worktree from origin/main, preserving local edits" } }], getSessionId: () => "fixture", getSessionFile: () => undefined };
    ctx.modelRegistry = { find: () => ctx.model, streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","category":"within_scope"}' }] }) }) };
    await request({ operation: "fast_forward", repository: linked, remote: "origin", branch: "main" });
    assert.equal(linkedGit("rev-parse", "HEAD"), fetched);
    assert.equal(readFileSync(join(linked, "remote-update"), "utf8"), "fetched content\n");
    assert.equal(readFileSync(join(linked, "unrelated-local"), "utf8"), "preserve\n");
    assert.equal(readFileSync(join(linked, "merge-proof"), "utf8"), "confined");
    assert.equal(readFileSync(join(root, "outside"), "utf8"), "unchanged");
    await assert.rejects(runProcess(launcher, ["-c", `touch ${quote(join(linked, "ordinary-denied"))}`], options), /denied|not permitted|read-only/i);
    process.env.PI_CODEX_SANDBOX_BIN = join(root, "missing");
    await assert.rejects(request({ operation: "stage", paths: ["file"] }));
    assert.equal(git("diff", "--cached", "--name-only").trim(), "");
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
