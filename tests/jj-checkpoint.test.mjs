import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "JJ_CONFIG", "XDG_CONFIG_HOME"], before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: join(root, "jj.toml"), XDG_CONFIG_HOME: join(root, "config") });
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

function metadataFiles(root) {
  return readdirSync(root, { recursive: true }).sort().filter(path => lstatSync(join(root, path)).isFile()).map(path => [path, readFileSync(join(root, path)).toString("hex")]);
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

test("main checkpoints preserve eight linked worktrees and borrow existing history without copying it", { timeout: 30000 }, async t => {
  const f = fixture(t); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "committed\n"); f.git("add", "file"); f.git("commit", "-m", "fixture");
  f.git("gc", "--prune=now");
  writeFileSync(join(f.cwd, ".git/info/exclude"), ".internal-worktrees/\n");
  const worktrees = Array.from({ length: 8 }, (_, index) => join(index === 7 ? join(f.cwd, ".internal-worktrees") : f.root, `linked-${index}`));
  for (const [index, path] of worktrees.entries()) {
    f.git("worktree", "add", ...(index ? ["--detach"] : ["-b", "topic"]), path, "HEAD");
    writeFileSync(join(path, "file"), `linked ${index}\n`);
  }
  writeFileSync(join(f.cwd, ".git/worktrees/linked-0/index.lock"), "other worktree owns this lock\n");
  // Git ignores this sparse fixture; copying the whole object pool would exceed both limits.
  const oversized = join(f.cwd, ".git/objects/info/fixture-no-copy");
  writeFileSync(oversized, ""); truncateSync(oversized, 129 * 1024 * 1024);
  writeFileSync(join(f.cwd, "file"), "staged\n"); f.git("add", "file"); writeFileSync(join(f.cwd, "file"), "main before\n");
  writeFileSync(join(f.cwd, "new"), "new main\n");
  const index = readFileSync(join(f.cwd, ".git/index")), head = f.git("rev-parse", "HEAD"), config = readFileSync(join(f.cwd, ".git/config"));
  const branches = f.git("for-each-ref", "refs/heads"), listing = f.git("worktree", "list", "--porcelain");
  const { tx, result } = await f.prepare();
  assert.equal(existsSync(join(tx.stage, ".git/worktrees")), false);
  assert.equal(existsSync(join(tx.stage, ".internal-worktrees")), false);
  assert.deepEqual(readdirSync(join(tx.stage, ".git/objects/pack")), []);
  assert.equal(readFileSync(join(tx.stage, ".git/objects/info/alternates"), "utf8"), join(f.cwd, ".git/objects") + "\n");
  assert.ok([...tx.gitBefore.keys()].every(path => !/^(objects|worktrees)\//.test(path)));
  // An independent worktree can update its private index while the main snapshot runs.
  writeFileSync(join(worktrees[1], "file"), "concurrent linked edit\n");
  f.git("-C", worktrees[1], "add", "file");
  const registrations = metadataFiles(join(f.cwd, ".git/worktrees"));
  const linkedFiles = worktrees.map(path => metadataFiles(path));
  const first = publishCheckpoint(tx, result);
  writeFileSync(join(f.cwd, "file"), "main after\n");
  const second = await f.checkpoint();
  assert.notEqual(first.operationId, second.operationId);
  assert.equal(f.git("show", `${first.gitRef}:file`), "main before");
  assert.equal(f.git("show", `${second.gitRef}:file`), "main after");
  assert.equal(f.git("show", `${second.gitRef}:new`), "new main");
  assert.deepEqual(f.git("ls-tree", "-r", "--name-only", second.gitRef).split("\n"), ["file", "new"]);
  assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), index);
  assert.deepEqual(readFileSync(join(f.cwd, ".git/config")), config);
  assert.equal(f.git("rev-parse", "HEAD"), head); assert.equal(f.git("for-each-ref", "refs/heads"), branches);
  assert.equal(f.git("worktree", "list", "--porcelain"), listing);
  assert.deepEqual(metadataFiles(join(f.cwd, ".git/worktrees")), registrations);
  assert.deepEqual(worktrees.map(path => metadataFiles(path)), linkedFiles);
  assert.equal(existsSync(join(f.cwd, ".git/objects/info/alternates")), false);
  assert.equal(lstatSync(oversized).size, 129 * 1024 * 1024);
});

test("worker worktree registrations and alternate redirections cannot be published", { timeout: 15000 }, async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "before\n");
  const { tx, result } = await f.prepare(), alternate = join(tx.stage, ".git/objects/info/alternates");
  writeFileSync(alternate, "/tmp/another-object-pool\n");
  assert.throws(() => publishCheckpoint(tx, result), /changed its read-only object pool/);
  writeFileSync(alternate, tx.alternates);
  mkdirSync(join(tx.stage, ".git/worktrees/forged"), { recursive: true });
  writeFileSync(join(tx.stage, ".git/worktrees/forged/gitdir"), "/tmp/forged/.git\n");
  assert.throws(() => publishCheckpoint(tx, result), /unapproved Git metadata/);
  rmSync(join(tx.stage, ".git/worktrees"), { recursive: true });
  const pool = join(f.cwd, ".git/objects"), moved = join(f.root, "original-objects");
  renameSync(pool, moved); mkdirSync(pool);
  assert.throws(() => publishCheckpoint(tx, result), /source changed/);
  rmSync(pool, { recursive: true }); symlinkSync(moved, pool);
  assert.throws(() => publishCheckpoint(tx, result), /redirected or unsafe object pool/);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
});

test("working-file symbolic links are captured literally without following their targets", { timeout: 15000 }, async t => {
  const f = fixture(t); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "main\n");
  const external = join(f.root, "external"); mkdirSync(external); writeFileSync(join(external, "private"), "outside contents\n");
  const links = { local: "file", dangling: "missing", outside: external, metadata: ".git/config" };
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(f.cwd, path));
  f.git("add", "file", ...Object.keys(links)); f.git("commit", "-m", "links");
  const { tx, result } = await f.prepare();
  // A link replaced by a regular file containing the same bytes must still fail.
  rmSync(join(tx.stage, "local")); writeFileSync(join(tx.stage, "local"), "file", { mode: 0o777 });
  assert.throws(() => publishCheckpoint(tx, result), /worker changed working files/);
  rmSync(join(tx.stage, "local")); symlinkSync("file", join(tx.stage, "local"));
  rmSync(join(f.cwd, "dangling")); symlinkSync("changed", join(f.cwd, "dangling"));
  assert.throws(() => publishCheckpoint(tx, result), /source changed/);
  rmSync(join(f.cwd, "dangling")); symlinkSync("missing", join(f.cwd, "dangling"));
  assert.throws(() => createCheckpointTransaction({ ...tx.info, files: ["outside/private"] }), /outside its root|redirected/);
  const checkpoint = publishCheckpoint(tx, result);
  for (const [path, target] of Object.entries(links)) {
    assert.equal(f.git("show", `${checkpoint.gitRef}:${path}`), target);
    assert.match(f.git("ls-tree", checkpoint.gitRef, path), /^120000 blob /);
    assert.equal(lstatSync(join(f.cwd, path)).isSymbolicLink(), true);
  }
  assert.equal(readFileSync(join(external, "private"), "utf8"), "outside contents\n");
  assert.deepEqual(readdirSync(external), ["private"]);
});

test("publication reuses identical concurrent objects but refuses conflicting objects and shared branch changes", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "before\n");
  f.git("add", "file"); f.git("commit", "-m", "fixture");
  writeFileSync(join(f.cwd, "file"), "dirty\n");
  const { tx, result } = await f.prepare();
  const object = readdirSync(join(tx.stage, ".git/objects"), { recursive: true }).find(path => /^[a-f0-9]{2}\/[a-f0-9]{38}$/.test(path));
  assert.ok(object);
  const target = join(f.cwd, ".git/objects", object), source = readFileSync(join(tx.stage, ".git/objects", object));
  mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "conflict\n");
  assert.throws(() => publishCheckpoint(tx, result), /conflicting existing Git object/);
  assert.equal(existsSync(join(f.cwd, ".jj")), false);
  writeFileSync(target, source);
  f.git("update-ref", "refs/heads/concurrent", "HEAD");
  assert.throws(() => publishCheckpoint(tx, result), /source changed/);
  f.git("update-ref", "-d", "refs/heads/concurrent");
  // The branch update also creates a reflog, which is shared metadata.
  rmSync(join(f.cwd, ".git/logs/refs/heads/concurrent"), { force: true });
  const checkpoint = publishCheckpoint(tx, result);
  assert.equal(f.git("show", `${checkpoint.gitRef}:file`), "dirty");
  assert.deepEqual(readFileSync(target), source);
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

test("copied checkpoints retain secure repository and workspace configuration without publishing temporary IDs", { timeout: 20000 }, async t => {
  const f = fixture(t); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "first\n");
  await f.checkpoint();
  f.jj("config", "set", "--repo", "user.name", "Repository Fixture");
  f.jj("config", "set", "--workspace", "user.email", "workspace@example.com");
  const configuration = ["repo/config-id", "workspace-config-id"].flatMap((path, index) => {
    const file = join(f.cwd, ".jj", path), id = readFileSync(file, "utf8");
    return [file, ...["config.toml", "metadata.binpb"].map(name => join(process.env.XDG_CONFIG_HOME, "jj", index ? "workspaces" : "repos", id, name))];
  });
  const before = configuration.map(path => readFileSync(path));
  writeFileSync(join(f.cwd, "file"), "next\n");
  const checkpoint = await f.checkpoint();
  assert.equal(f.git("show", "-s", "--format=%cn <%ce>", checkpoint.gitRef), "Repository Fixture <workspace@example.com>");
  configuration.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  assert.equal(f.git("show", `${checkpoint.gitRef}:file`), "next");
  f.jj("config", "set", "--repo", "snapshot.auto-track", "none()");
  writeFileSync(join(f.cwd, "new"), "must not bypass repository policy\n");
  await assert.rejects(f.checkpoint(), /did not capture/);
});

test("checkpoint refusal identifies the exact Git state marker", async t => {
  const f = fixture(t); if (!f) return;
  for (const marker of ["MERGE_HEAD", "worktrees", "info/sparse-checkout", "objects/info/alternates"]) {
    const path = join(f.cwd, ".git", marker);
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "fixture");
    await assert.rejects(inspectCheckpoint(f.cwd, f.binary), error => error.message.includes(`.git/${marker}`));
    rmSync(path);
  }
});

test("initial Git metadata accepts filesystem booleans but rejects helpers, redirections and duplicate keys", { timeout: 15000 }, async t => {
  const f = fixture(t, false); if (!f) return;
  writeFileSync(join(f.cwd, "file"), "original\n");
  const { tx, result } = await f.prepare();
  const path = join(tx.stage, ".git/config");
  const base = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
  for (const suffix of [
    "\thooksPath = /tmp/helper\n", "\tworktree = /tmp/redirect\n", "\tfsmonitor = helper\n",
    "[include]\n\tpath = /tmp/config\n", "\tignorecase = helper\n", "\tprecomposeunicode = helper\n",
    "\tignorecase = true\n\tignorecase = false\n", "\tprecomposeunicode = true\n\tprecomposeunicode = false\n",
  ]) {
    writeFileSync(path, base + suffix);
    assert.throws(() => publishCheckpoint(tx, result), /Unexpected initial Git configuration/);
    assert.equal(existsSync(join(f.cwd, ".git/config")), false);
    assert.equal(existsSync(join(f.cwd, ".jj")), false);
  }
  writeFileSync(path, base + "\tignorecase = false\n\tprecomposeunicode = true\n");
  const published = publishCheckpoint(tx, result);
  assert.equal(f.git("show", `${published.gitRef}:file`), "original");
  assert.equal(readFileSync(join(f.cwd, ".git/config"), "utf8"), readFileSync(path, "utf8"));
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

test("linked worktree roots, bare repositories, submodules, metadata symlinks and existing locks fail without source writes", async t => {
  const f = fixture(t); if (!f) return; writeFileSync(join(f.cwd, "file"), "before\n");
  const subdir = join(f.cwd, "subdir"); mkdirSync(subdir); assert.equal(checkpointRoot(subdir), f.cwd);
  writeFileSync(join(f.cwd, ".gitmodules"), ""); await assert.rejects(inspectCheckpoint(f.cwd, f.binary), /submodules/); rmSync(join(f.cwd, ".gitmodules"));
  const info = await inspectCheckpoint(f.cwd, f.binary); writeFileSync(join(f.cwd, ".git/index.lock"), "other owner");
  assert.throws(() => createCheckpointTransaction(info), /existing metadata lock/); assert.equal(readFileSync(join(f.cwd, ".git/index.lock"), "utf8"), "other owner"); rmSync(join(f.cwd, ".git/index.lock"));
  symlinkSync(join(f.cwd, "file"), join(f.cwd, ".git/info/link")); assert.throws(() => createCheckpointTransaction(info), /linked/);
  const linked = join(f.root, "linked"); mkdirSync(linked); writeFileSync(join(linked, ".git"), "gitdir: ../project/.git/worktrees/linked\n"); assert.throws(() => checkpointRoot(linked), /worktrees/);
  const bare = join(f.root, "bare"); mkdirSync(bare); mkdirSync(join(bare, "objects")); writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n"); assert.throws(() => checkpointRoot(bare), /bare/);
});
