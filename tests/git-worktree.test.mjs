import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveWorktrees, inspectWorktrees, worktreeRequest } from "../lib/git-worktree.ts";
import { registerGitWorktree } from "../extensions/tool-policy/git-worktree.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";
import { STRICT_TOOLS } from "../extensions/tool-policy/index.ts";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-cleanup-"))), cwd = join(base, "repo"), agent = join(base, "agent");
  mkdirSync(cwd); mkdirSync(agent);
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(cwd, "file"), "committed\n"); writeFileSync(join(cwd, ".gitignore"), "ignored\n");
  git("add", "file", ".gitignore"); git("commit", "-m", "fixture");
  const linked = (name, detached = false) => { const path = join(base, name); git("worktree", "add", ...(detached ? ["--detach"] : ["-b", name]), path); return path; };
  const request = (operation, paths) => worktreeRequest({ operation, ...(paths ? { paths } : {}), reason: "fixture cleanup" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(base, { recursive: true, force: true }); });
  return { base, cwd, agent, git, linked, request };
}

test("worktree cleanup grammar requires exact paths and has no force, shell, branch deletion or purge", () => {
  for (const value of [{ operation: "remove" }, { operation: "remove", paths: ["../sibling"] }, { operation: "remove", paths: ["/tmp/a/../b"] }, { operation: "prune", paths: [] }, { operation: "remove", paths: ["/tmp/a"], force: true }, { operation: "purge" }]) assert.throws(() => worktreeRequest({ reason: "test", ...value }));
  assert.equal(STRICT_TOOLS.has("git_worktree_cleanup"), true);
  assert.equal(CONFINED_TOOLS.has("git_worktree_cleanup"), false);
});

test("removal preserves unpublished branches, dirty/staged/untracked/ignored files, metadata and detached HEAD recovery", async t => {
  const f = fixture(t), path = f.linked("unpublished"), detached = f.linked("detached", true);
  writeFileSync(join(path, "file"), "committed locally\n");
  f.git("-C", path, "add", "file"); f.git("-C", path, "commit", "-m", "local only");
  const head = f.git("-C", path, "rev-parse", "HEAD");
  writeFileSync(join(path, "file"), "staged\n"); f.git("-C", path, "add", "file");
  writeFileSync(join(path, "file"), "dirty\n"); writeFileSync(join(path, "new"), "untracked\n"); writeFileSync(join(path, "ignored"), "private\n");
  symlinkSync(join(f.cwd, "file"), join(path, "link"));
  f.git("pack-refs", "--all");
  const request = f.request("remove", [path, detached]), snapshot = await inspectWorktrees(f.cwd, request);
  assert.equal(snapshot.entries.find(entry => entry.path === path).knownRemote, false);
  assert.equal(snapshot.entries.find(entry => entry.path === path).dirty, true);
  const before = ["HEAD", "index", "config"].map(name => readFileSync(join(f.cwd, ".git", name)));
  const result = archiveWorktrees(snapshot, request, f.cwd, f.agent), receipt = JSON.parse(readFileSync(result.receipt));
  assert.equal(lstatSync(result.archive).mode & 0o777, 0o700);
  assert.equal(lstatSync(result.receipt).mode & 0o777, 0o600);
  assert.equal(existsSync(path), false); assert.equal(existsSync(detached), false);
  assert.equal(f.git("rev-parse", "refs/heads/unpublished"), head);
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length, 2);
  const archived = receipt.entries.find(entry => entry.path === path).archive;
  for (const [name, expected] of [["file", "dirty\n"], ["new", "untracked\n"], ["ignored", "private\n"]]) assert.equal(readFileSync(join(archived, "worktree", name), "utf8"), expected);
  assert.equal(lstatSync(join(archived, "worktree/link")).isSymbolicLink(), true);
  assert.equal(execFileSync("/usr/bin/git", ["--git-dir=" + join(archived, "metadata"), "--work-tree=" + join(archived, "worktree"), "show", ":file"], { env: { ...process.env, GIT_COMMON_DIR: join(f.cwd, ".git") }, encoding: "utf8" }).trim(), "staged");
  assert.equal(existsSync(join(archived, "metadata/index.lock")), false);
  for (const entry of result.removed) assert.equal(f.git("rev-parse", entry.recoveryRef), entry.head);
  ["HEAD", "index", "config"].forEach((name, index) => assert.deepEqual(readFileSync(join(f.cwd, ".git", name)), before[index]));
});

test("prune archives only explicitly selected missing registrations and keeps their commits reachable", async t => {
  const f = fixture(t), gone = f.linked("gone", true), other = f.linked("other-gone", true);
  rmSync(gone, { recursive: true }); rmSync(other, { recursive: true });
  const request = f.request("prune", [gone]), snapshot = await inspectWorktrees(f.cwd, request);
  const result = archiveWorktrees(snapshot, request, f.cwd, f.agent);
  assert.equal(f.git("rev-parse", result.removed[0].recoveryRef), snapshot.entries[0].head);
  assert.ok(f.git("worktree", "list", "--porcelain").includes(other));
  assert.ok(!f.git("worktree", "list", "--porcelain").includes(gone + "\n"));
  assert.equal(existsSync(join(result.archive, "0/worktree")), false);
});

test("locked, active, redirected, changed and forged worktrees never move", async t => {
  const f = fixture(t), path = f.linked("review"), request = f.request("remove", [path]);
  let snapshot = await inspectWorktrees(f.cwd, request);
  assert.throws(() => archiveWorktrees(snapshot, request, path, f.agent), /active workspace/);
  assert.throws(() => archiveWorktrees({ ...snapshot, entries: [{ ...snapshot.entries[0], head: "b".repeat(40) }] }, request, f.cwd, f.agent), /branch advanced/);
  writeFileSync(join(path, "new"), "late edit\n"); assert.throws(() => archiveWorktrees(snapshot, request, f.cwd, f.agent), /changed/);
  snapshot = await inspectWorktrees(f.cwd, request);
  f.git("worktree", "lock", path); assert.throws(() => archiveWorktrees(snapshot, request, f.cwd, f.agent), /changed/);
  snapshot = await inspectWorktrees(f.cwd, request); assert.throws(() => archiveWorktrees(snapshot, request, f.cwd, f.agent), /locked/);
  f.git("worktree", "unlock", path);
  writeFileSync(join(path, ".git"), `gitdir: ${join(f.cwd, ".git")}\n`);
  await assert.rejects(inspectWorktrees(f.cwd, request), /backlink/);
  assert.equal(readFileSync(join(path, "new"), "utf8"), "late edit\n");
  assert.equal(existsSync(join(f.agent, "worktree-archives")), false);
});

function broker(t, f, select) {
  const handlers = new Map(), tools = new Map();
  const ctx = { cwd: f.cwd, hasUI: true, ui: { select, notify() {} } };
  registerGitWorktree({ on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), getActiveTools: () => ["git_worktree_cleanup"] }, f.agent, () => {}, async (_program, args, options) => {
    assert.equal(args[0], "--offline"); assert.equal(args.includes("--write-roots"), false);
    return JSON.stringify({ result: await inspectWorktrees(options.cwd, worktreeRequest(JSON.parse(options.input)), options.signal) });
  });
  t.after(() => handlers.get("session_shutdown")());
  return { ctx, handlers, call: (operation, paths, signal) => tools.get("git_worktree_cleanup").execute("test", f.request(operation, paths), signal, undefined, ctx) };
}

test("broker inspects without consent, paginates exact one-time approvals and never inherits a local Git grant", async t => {
  const f = fixture(t), one = f.linked("first"), two = f.linked("second"); let approvals = 0;
  const b = broker(t, f, async (_title, choices) => {
    if (choices.includes("Lire la page suivante")) return "Lire la page suivante";
    approvals++; assert.deepEqual(choices.slice(0, 2), ["Refuser", "Autoriser cette fois"]);
    assert.equal(choices.includes("Toujours autoriser pour ce projet"), false);
    return choices[1];
  });
  await b.call("inspect"); assert.equal(approvals, 0);
  await b.call("remove", [one]); await b.call("remove", [two]); assert.equal(approvals, 2);
  assert.equal(existsSync(one), false); assert.equal(existsSync(two), false);
});

test("denial, changes during review, cancellation and child/headless calls cannot archive", async t => {
  const f = fixture(t), path = f.linked("preserve"), b = broker(t, f, async () => undefined);
  await assert.rejects(b.call("remove", [path]), /not approved/);
  await b.handlers.get("session_start")();
  b.ctx.ui.select = async (_title, choices) => {
    if (choices.includes("Lire la page suivante")) return "Lire la page suivante";
    writeFileSync(join(path, "new"), "changed during review"); return choices[1];
  };
  await assert.rejects(b.call("remove", [path]), /changed/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(b.call("remove", [path], controller.signal));
  b.ctx.hasUI = false; await assert.rejects(b.call("remove", [path]), /interactive parent/); b.ctx.hasUI = true;
  const old = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(b.call("remove", [path]), /interactive parent/); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = old; }
  assert.equal(existsSync(path), true); assert.equal(existsSync(join(f.agent, "worktree-archives")), false);
});

test("runtime targets, redirected archives, nested repositories and concurrent locks remain intact", async t => {
  const f = fixture(t), runtime = f.linked("agent/linked"); let prompts = 0;
  const b = broker(t, f, async () => { prompts++; return "Autoriser cette fois"; });
  await assert.rejects(b.call("remove", [runtime]), /protected|runtime|configuration/i); assert.equal(prompts, 0);
  assert.equal(existsSync(runtime), true);
  const path = f.linked("ordinary"), request = f.request("remove", [path]);
  let snapshot = await inspectWorktrees(f.cwd, request);
  symlinkSync(f.base, join(f.agent, "worktree-archives"));
  assert.throws(() => archiveWorktrees(snapshot, request, f.cwd, f.agent), /canonical/);
  rmSync(join(f.agent, "worktree-archives"));
  writeFileSync(join(snapshot.entries[0].metadata, "index.lock"), "other process");
  snapshot = await inspectWorktrees(f.cwd, request);
  assert.throws(() => archiveWorktrees(snapshot, request, f.cwd, f.agent), /active operation/);
  assert.equal(readFileSync(join(snapshot.entries[0].metadata, "index.lock"), "utf8"), "other process");
  rmSync(join(snapshot.entries[0].metadata, "index.lock"));
  mkdirSync(join(path, "nested")); mkdirSync(join(path, "nested/.git"));
  await assert.rejects(inspectWorktrees(f.cwd, request), /nested repository/);
  assert.equal(existsSync(path), true);
});
