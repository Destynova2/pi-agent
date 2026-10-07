// The operator gate uses a real sandbox; it never retries Git without confinement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registerGitWorktree } from "../extensions/tool-policy/git-worktree.ts";
import { runProcess } from "../lib/process.ts";
import { runtimeRoot } from "../lib/runtime-paths.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("native worktree approval archives only selected files and metadata without granting Bash access", { timeout: 90000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "git-worktree-jail-"))), cwd = join(base, "repo"), agent = join(base, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const keys = ["PI_CODING_AGENT_DIR", "PI_CODEX_SANDBOX_BIN", "PI_CODEX_NETWORK_GRANTS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: codex, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }); delete process.env.PI_CODEX_NETWORK_GRANTS;
  const handlers = new Map(); let tool;
  t.after(async () => {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(join(agent, "network-policy.json"), '{"allow":[]}'); writeFileSync(join(agent, "settings.json"), "{}");
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(cwd, "file"), "committed\n"); git("add", "file"); git("commit", "-m", "fixture");
  const selected = join(base, "selected"), retained = join(base, "retained"), missing = join(base, "missing");
  git("worktree", "add", "-b", "local-only", selected); git("worktree", "add", "--detach", retained); git("worktree", "add", "--detach", missing);
  rmSync(missing, { recursive: true });
  writeFileSync(join(selected, "file"), "staged\n"); git("-C", selected, "add", "file"); writeFileSync(join(selected, "file"), "dirty\n");
  writeFileSync(join(selected, "untracked"), "keep\n");
  const launcher = join(runtimeRoot, "scripts/codex-shell.mjs"), options = { cwd, timeoutMs: 30000, maxBytes: 1024 * 1024 };
  const ordinary = command => runProcess(launcher, ["--offline", "-c", command], options);
  await assert.rejects(ordinary(`/usr/bin/git worktree remove ${quote(selected)}`));
  await assert.rejects(ordinary(`rm ${quote(join(selected, "untracked"))}`), /denied|not permitted|read-only/i);
  const probe = join(cwd, "fsmonitor-executed"), helper = join(cwd, "monitor.sh");
  writeFileSync(helper, `#!/bin/sh\ntouch ${quote(probe)}\n`, { mode: 0o755 }); git("config", "core.fsmonitor", helper);
  const filterProbe = join(cwd, "filter-executed"), filter = join(cwd, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch ${quote(filterProbe)}\ncat\n`, { mode: 0o755 });
  writeFileSync(join(selected, ".gitattributes"), "file filter=fixture\n");
  git("config", "filter.fixture.clean", filter); git("config", "filter.fixture.required", "true");
  // Match the indexed size so status must compare contents rather than stop at stat.
  writeFileSync(join(selected, "file"), "dirty!\n");
  git("-c", "core.fsmonitor=false", "-C", selected, "status", "--porcelain=v1");
  assert.equal(existsSync(filterProbe), true, "ordinary Git status launches the configured filter"); rmSync(filterProbe);
  const before = ["HEAD", "index", "config"].map(name => readFileSync(join(cwd, ".git", name)));
  let approvals = 0, pages = 0;
  const ctx = { cwd, hasUI: true, ui: { select: async (_title, choices) => {
    pages++;
    if (choices.includes("Lire la page suivante")) return "Lire la page suivante";
    approvals++; return "Autoriser cette fois";
  }, notify() {} } };
  registerGitWorktree({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: value => { tool = value; }, getActiveTools: () => ["git_worktree_cleanup"] }, agent, () => {});
  const request = async (operation, paths) => JSON.parse((await tool.execute("fixture", { operation, ...(paths ? { paths } : {}), reason: "isolated fixture only" }, undefined, undefined, ctx)).content[0].text);
  assert.equal((await request("inspect")).entries.length, 3); assert.equal(approvals, 0);
  const result = await request("remove", [selected]);
  assert.equal(approvals, 1); assert.ok(pages > 1); assert.equal(existsSync(selected), false); assert.equal(existsSync(retained), true);
  assert.equal(readFileSync(join(result.archive, "0/worktree/file"), "utf8"), "dirty!\n");
  assert.equal(readFileSync(join(result.archive, "0/worktree/untracked"), "utf8"), "keep\n");
  assert.equal(git("rev-parse", "refs/heads/local-only"), result.removed[0].head);
  assert.equal(git("rev-parse", result.removed[0].recoveryRef), result.removed[0].head);
  await assert.rejects(ordinary(`rm ${quote(join(result.archive, "0/worktree/untracked"))}`), /denied|not permitted|read-only/i);
  await assert.rejects(ordinary(`/usr/bin/git update-ref refs/heads/unauthorized HEAD`), /denied|not permitted|read-only/i);
  // A linked active workspace can retire a missing sibling, never itself.
  ctx.cwd = retained;
  await assert.rejects(request("remove", [retained]), /active workspace/);
  await request("prune", [missing]); assert.equal(approvals, 2);
  assert.equal((await request("inspect")).entries.length, 1);
  assert.equal(existsSync(probe), false, "repository fsmonitor is never launched during inspection");
  assert.equal(existsSync(filterProbe), false, "repository filters are never launched during inspection");
  ["HEAD", "index", "config"].forEach((name, i) => assert.deepEqual(readFileSync(join(cwd, ".git", name)), before[i]));
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), "{}");
});
