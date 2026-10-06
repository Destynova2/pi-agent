import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointReason, checkpointRoot, inspectCheckpoint, createCheckpointTransaction, runCheckpoint, publishCheckpoint, closeCheckpointTransaction } from "../lib/jj-checkpoint.ts";
import { serverIdentity } from "../lib/mcp-approvals.ts";

function fixture(t, gitRepository = true) {
  let binary;
  try { binary = serverIdentity("jj", [], process.cwd()).command; }
  catch (error) {
    if (process.env.PI_TEST_INTEGRATION === "1") throw error;
    t.skip("jj is not installed; checkpoint fixtures require jj"); return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-checkpoint-test-"))), cwd = join(root, "project"); mkdirSync(cwd);
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG"], before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: join(root, "jj.toml") });
  writeFileSync(process.env.JJ_CONFIG, '[user]\nname = "Fixture"\nemail = "fixture@example.com"\n');
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const jj = (...args) => execFileSync(binary, ["--no-pager", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (gitRepository) { git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com"); }
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const prepare = async () => {
    const info = await inspectCheckpoint(cwd, binary), tx = createCheckpointTransaction(info);
    t.after(() => closeCheckpointTransaction(tx));
    return { tx, result: await runCheckpoint(tx.stage, binary) };
  };
  const checkpoint = async () => { const { tx, result } = await prepare(); return publishCheckpoint(tx, result); };
  return { root, cwd, binary, git, jj, prepare, checkpoint };
}

test("checkpoint input cannot request restore, paths, arbitrary commands or control characters", () => {
  assert.equal(checkpointReason({ reason: "before edits" }), "before edits");
  for (const input of [{ reason: "" }, { reason: "bad\nreason" }, { reason: "test", command: "restore" }, { reason: "test", root: "/" }]) assert.throws(() => checkpointReason(input));
});

test("initialization and later checkpoints recover dirty and untracked files while preserving Git staging", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "committed\n"); f.git("add", "file"); f.git("commit", "-m", "fixture");
  writeFileSync(join(f.cwd, "file"), "staged\n"); f.git("add", "file"); writeFileSync(join(f.cwd, "file"), "before task\n");
  writeFileSync(join(f.cwd, "new"), "new before task\n"); writeFileSync(join(f.cwd, ".gitignore"), "ignored\n"); writeFileSync(join(f.cwd, "ignored"), "private\n");
  writeFileSync(join(f.cwd, " leading space"), "literal\n");
  const index = readFileSync(join(f.cwd, ".git/index")), head = f.git("rev-parse", "HEAD"), config = readFileSync(join(f.cwd, ".git/config"));
  const first = await f.checkpoint();
  assert.equal(first.initialized, true); assert.equal(f.jj("--ignore-working-copy", "root"), f.cwd);
  assert.equal(f.git("rev-parse", "--verify", first.gitRef), first.commitId);
  assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), index); assert.equal(f.git("rev-parse", "HEAD"), head); assert.deepEqual(readFileSync(join(f.cwd, ".git/config")), config);
  assert.equal(f.jj("--ignore-working-copy", "file", "show", "-r", first.commitId, "file"), "before task");
  assert.equal(f.jj("--ignore-working-copy", "file", "show", "-r", first.commitId, "new"), "new before task");
  assert.ok(!f.jj("--ignore-working-copy", "file", "list", "-r", first.commitId).split("\n").includes("ignored"));
  writeFileSync(join(f.cwd, "file"), "second task\n"); rmSync(join(f.cwd, "new"));
  const second = await f.checkpoint(); assert.equal(second.initialized, false); assert.notEqual(second.operationId, first.operationId);
  assert.equal(f.git("show", `${first.gitRef}:file`), "before task");
  assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), index); assert.equal(f.git("branch", "--show-current"), "main");
  // Destructive recovery runs only on this disposable fixture, by explicit test code.
  f.jj("restore", "--from", first.commitId);
  assert.equal(readFileSync(join(f.cwd, "file"), "utf8"), "before task\n"); assert.equal(readFileSync(join(f.cwd, "new"), "utf8"), "new before task\n");
  assert.equal(readFileSync(join(f.cwd, "ignored"), "utf8"), "private\n");
});

for (const emptyGit of [false, true]) test(`a plain directory gets a recoverable jj checkpoint without a Git commit (empty .git: ${emptyGit})`, { timeout: 15000 }, async t => {
  const f = fixture(t, false); if (!f) return; writeFileSync(join(f.cwd, "file"), "original\n");
  if (emptyGit) mkdirSync(join(f.cwd, ".git"));
  const gitInode = emptyGit ? lstatSync(join(f.cwd, ".git")).ino : undefined;
  const result = await f.checkpoint();
  if (emptyGit) assert.equal(lstatSync(join(f.cwd, ".git")).ino, gitInode, "preserve the existing empty metadata directory");
  assert.equal(f.git("rev-parse", "--revs-only", "HEAD"), "");
  assert.equal(f.jj("--ignore-working-copy", "file", "show", "-r", result.commitId, "file"), "original");
});

test("nonempty invalid Git metadata is refused and preserved", async t => {
  const f = fixture(t, false); if (!f) return;
  mkdirSync(join(f.cwd, ".git"));
  writeFileSync(join(f.cwd, ".git/owned"), "existing metadata\n");
  await assert.rejects(inspectCheckpoint(f.cwd, f.binary), /not a git repository/);
  assert.equal(readFileSync(join(f.cwd, ".git/owned"), "utf8"), "existing metadata\n");
  assert.equal(existsSync(join(f.cwd, ".git/HEAD")), false);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

test("absent protected resources never become files in the checkpoint", { timeout: 15000 }, async t => {
  const f = fixture(t); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "original\n");
  const info = await inspectCheckpoint(f.cwd, f.binary);
  // A confined inspection can see Linux mount placeholders absent on the host.
  const tx = createCheckpointTransaction({ ...info, files: [...info.files, ".pi"] });
  t.after(() => closeCheckpointTransaction(tx));
  const result = publishCheckpoint(tx, await runCheckpoint(tx.stage, f.binary));
  assert.equal(f.git("ls-tree", "-r", "--name-only", result.gitRef), "file");
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  assert.equal(existsSync(join(f.cwd, ".agents")), false);
  assert.equal(existsSync(join(f.cwd, ".codex")), false);
});

test("files omitted by jj size or auto-track settings never produce a successful checkpoint", { timeout: 15000 }, async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "original\n");
  await f.checkpoint();
  writeFileSync(join(f.cwd, "large"), Buffer.alloc(2 * 1024 * 1024, 97));
  let next = await f.prepare(); assert.throws(() => publishCheckpoint(next.tx, next.result), /did not capture/);
  rmSync(join(f.cwd, "large"));
  writeFileSync(process.env.JJ_CONFIG, '[user]\nname = "Fixture"\nemail = "fixture@example.com"\n[snapshot]\nauto-track = "none()"\n');
  writeFileSync(join(f.cwd, "new"), "must not be omitted\n");
  next = await f.prepare(); assert.throws(() => publishCheckpoint(next.tx, next.result), /did not capture/);
});

test("publication rejects changed sources, worker config changes, forged objects and redirected metadata", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "before\n");
  for (const kind of ["config", "object", "source", "symlink"]) {
    const { tx, result } = await f.prepare();
    if (kind === "config") writeFileSync(join(tx.stage, ".git/config"), "[core]\n hooksPath=/tmp/bad\n");
    if (kind === "object") { mkdirSync(join(tx.stage, ".git/objects/aa"), { recursive: true }); writeFileSync(join(tx.stage, ".git/objects/aa/" + "b".repeat(38)), "bad"); }
    if (kind === "source") writeFileSync(join(f.cwd, "file"), "concurrent\n");
    if (kind === "symlink") { rmSync(join(tx.stage, ".jj/repo/store/git_target")); symlinkSync(join(f.cwd, "file"), join(tx.stage, ".jj/repo/store/git_target")); }
    assert.throws(() => publishCheckpoint(tx, result));
    assert.equal(existsSync(join(f.cwd, ".jj")), false); assert.equal(existsSync(join(f.cwd, ".git/index.lock")), false);
    writeFileSync(join(f.cwd, "file"), "before\n");
  }
});

test("linked worktrees, bare repositories, submodules, symlinks and existing locks fail without source writes", async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "before\n");
  const subdir = join(f.cwd, "subdir"); mkdirSync(subdir); assert.equal(checkpointRoot(subdir), f.cwd);
  writeFileSync(join(f.cwd, ".gitmodules"), ""); await assert.rejects(inspectCheckpoint(f.cwd, f.binary), /submodules/); rmSync(join(f.cwd, ".gitmodules"));
  const info = await inspectCheckpoint(f.cwd, f.binary); writeFileSync(join(f.cwd, ".git/index.lock"), "other owner");
  assert.throws(() => createCheckpointTransaction(info), /existing metadata lock/); assert.equal(readFileSync(join(f.cwd, ".git/index.lock"), "utf8"), "other owner"); rmSync(join(f.cwd, ".git/index.lock"));
  symlinkSync(join(f.cwd, "file"), join(f.cwd, "link")); assert.throws(() => createCheckpointTransaction({ ...info, files: ["link"] }), /linked/);
  const linked = join(f.root, "linked"); mkdirSync(linked); writeFileSync(join(linked, ".git"), "gitdir: ../project/.git/worktrees/linked\n"); assert.throws(() => checkpointRoot(linked), /worktrees/);
  const bare = join(f.root, "bare"); mkdirSync(bare); mkdirSync(join(bare, "objects")); writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n"); assert.throws(() => checkpointRoot(bare), /bare/);
});
