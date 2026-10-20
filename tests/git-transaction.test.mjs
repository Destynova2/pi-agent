import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs, { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { deflateSync, inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitTransaction, publishGitTransaction, closeGitTransaction } from "../lib/git-transaction.ts";
import { inspectGit, gitOperationArgs } from "../extensions/tool-policy/git-access-core.ts";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-transaction-test-"))), cwd = join(root, "project");
  mkdirSync(cwd);
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(cwd, "file"), "approved\n");
  const request = { operation: "stage", paths: ["file"], reason: "fixture" };
  const snapshot = await inspectGit(cwd, request);
  const tx = createGitTransaction(snapshot, request);
  t.after(() => { closeGitTransaction(tx); rmSync(root, { recursive: true, force: true }); });
  const worker = () => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/git-operation.mjs", import.meta.url))], {
      cwd, encoding: "utf8", input: JSON.stringify({ action: "execute", request, expected: snapshot, transaction: tx.commonDir }),
    });
    const result = JSON.parse(output);
    assert.equal(result.error, undefined, result.error);
    return result.result;
  };
  return { root, cwd, git, request, snapshot, tx, worker };
}

test("Linux Git transaction stages in disposable metadata then atomically publishes only approved data", async t => {
  const f = await fixture(t), config = readFileSync(join(f.snapshot.gitDir, "config"));
  f.worker();
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.ok(existsSync(join(f.tx.commonDir, "index")));
  assert.deepEqual(publishGitTransaction(f.tx), ["index"]);
  assert.equal(f.git("diff", "--cached", "--name-only"), "file");
  assert.equal(f.git("show", ":file"), "approved");
  assert.deepEqual(readFileSync(join(f.snapshot.gitDir, "config")), config);
  assert.equal(existsSync(join(f.snapshot.gitDir, "index.lock")), false);
});

test("unapproved metadata, links and deleted files are refused before publishing", async t => {
  for (const kind of ["config", "hook", "link", "delete", "alternates", "unrelated-ref"]) {
    const f = await fixture(t); f.worker();
    if (kind === "config") writeFileSync(join(f.tx.commonDir, "config"), "[alias]\nx = !malicious\n");
    if (kind === "hook") writeFileSync(join(f.tx.commonDir, "hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
    if (kind === "link") { rmSync(join(f.tx.commonDir, "index")); symlinkSync(join(f.cwd, "file"), join(f.tx.commonDir, "index")); }
    if (kind === "delete") rmSync(join(f.tx.commonDir, "HEAD"));
    if (kind === "alternates") writeFileSync(join(f.tx.commonDir, "objects/info/alternates"), "/elsewhere\n");
    if (kind === "unrelated-ref") {
      mkdirSync(join(f.tx.commonDir, "refs/heads"), { recursive: true });
      writeFileSync(join(f.tx.commonDir, "refs/heads/unrelated"), "a".repeat(40) + "\n");
    }
    assert.throws(() => publishGitTransaction(f.tx), /unapproved|Linked|object pool/);
    assert.equal(f.git("diff", "--cached", "--name-only"), "");
    assert.equal(existsSync(join(f.snapshot.gitDir, "index.lock")), false);
  }
});

test("concurrent source changes and pre-existing locks stop publication without removing another process's lock", async t => {
  for (const kind of ["source", "lock"]) {
    const f = await fixture(t); f.worker();
    const path = join(f.snapshot.gitDir, kind === "source" ? "config" : "index.lock");
    writeFileSync(path, kind === "source" ? readFileSync(path, "utf8") + "\n# changed\n" : "owned elsewhere");
    assert.throws(() => publishGitTransaction(f.tx), /state changed|EEXIST/);
    assert.equal(f.git("diff", "--cached", "--name-only"), "");
    if (kind === "lock") assert.equal(readFileSync(path, "utf8"), "owned elsewhere");
  }
});

test("new object destinations cannot redirect publication outside Git", async t => {
  const f = await fixture(t); f.worker();
  const directory = readdirObjectPrefix(f.tx.commonDir);
  symlinkSync(f.root, join(f.snapshot.commonDir, "objects", directory));
  assert.throws(() => publishGitTransaction(f.tx), /Linked/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});
test("existing objects with identical Git content may use different compression", async t => {
  const f = await fixture(t); f.worker();
  const prefix = readdirObjectPrefix(f.tx.commonDir);
  const name = readdirSync(join(f.tx.commonDir, "objects", prefix))[0];
  const incoming = readFileSync(join(f.tx.commonDir, "objects", prefix, name));
  const existing = deflateSync(inflateSync(incoming), { level: 0 });
  assert.notDeepEqual(existing, incoming);
  const directory = join(f.snapshot.commonDir, "objects", prefix);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, name);
  writeFileSync(target, existing);
  assert.deepEqual(publishGitTransaction(f.tx), ["index"]);
  assert.deepEqual(readFileSync(target), existing, "existing object must not be rewritten");
  assert.equal(f.git("show", ":file"), "approved");
  f.git("fsck", "--no-reflogs", "--no-dangling");
});

test("existing corrupt, different, symlinked and hardlinked objects are refused", async t => {
  for (const kind of ["corrupt", "different", "symlink", "dangling", "hardlink", "directory", "oversized"]) {
    const f = await fixture(t); f.worker();
    const prefix = readdirObjectPrefix(f.tx.commonDir);
    const name = readdirSync(join(f.tx.commonDir, "objects", prefix))[0];
    const incoming = readFileSync(join(f.tx.commonDir, "objects", prefix, name));
    const directory = join(f.snapshot.commonDir, "objects", prefix);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, name), external = join(f.root, "external-object");
    writeFileSync(external, incoming);
    if (kind === "corrupt") writeFileSync(target, "not zlib");
    if (kind === "different") writeFileSync(target, deflateSync(Buffer.from("blob 9\0rejected\n")));
    if (kind === "symlink") symlinkSync(external, target);
    if (kind === "dangling") symlinkSync(join(f.root, "missing"), target);
    if (kind === "hardlink") linkSync(external, target);
    if (kind === "directory") mkdirSync(target);
    if (kind === "oversized") { writeFileSync(target, ""); truncateSync(target, 64 * 1024 * 1024 + 1); }
    assert.throws(() => publishGitTransaction(f.tx), /Conflicting Git object/);
    assert.equal(f.git("diff", "--cached", "--name-only"), "");
    assert.equal(existsSync(join(f.snapshot.gitDir, "index.lock")), false);
    assert.deepEqual(readFileSync(external), incoming);
  }
});

test("objects appearing during publication are validated on EEXIST", async t => {
  for (const kind of ["same", "different", "symlink", "hardlink"]) {
    const f = await fixture(t); f.worker();
    const prefix = readdirObjectPrefix(f.tx.commonDir);
    const name = readdirSync(join(f.tx.commonDir, "objects", prefix))[0];
    const incoming = readFileSync(join(f.tx.commonDir, "objects", prefix, name));
    const existing = deflateSync(inflateSync(incoming), { level: 0 });
    const target = join(f.snapshot.commonDir, "objects", prefix, name);
    const external = join(f.root, "external-object");
    writeFileSync(external, existing);
    const original = fs.writeFileSync;
    let raced = false;
    const mocked = t.mock.method(fs, "writeFileSync", (path, data, options) => {
      if (path === target && options?.flag === "wx") {
        raced = true;
        if (kind === "same") original(target, existing);
        if (kind === "different") original(target, deflateSync(Buffer.from("blob 9\0rejected\n")));
        if (kind === "symlink") symlinkSync(external, target);
        if (kind === "hardlink") linkSync(external, target);
      }
      return original(path, data, options);
    });
    syncBuiltinESMExports();
    try {
      if (kind === "same") {
        assert.deepEqual(publishGitTransaction(f.tx), ["index"]);
        assert.equal(f.git("show", ":file"), "approved");
        assert.deepEqual(readFileSync(target), existing);
      } else {
        assert.throws(() => publishGitTransaction(f.tx), /Conflicting Git object/);
        assert.equal(f.git("diff", "--cached", "--name-only"), "");
      }
      assert.equal(raced, true);
      assert.deepEqual(readFileSync(external), existing);
      assert.equal(existsSync(join(f.snapshot.gitDir, "index.lock")), false);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("existing objects changed during validation are refused before publishing the index", async t => {
  for (const kind of ["replace", "grow", "hardlink"]) {
    const f = await fixture(t); f.worker();
    const prefix = readdirObjectPrefix(f.tx.commonDir);
    const name = readdirSync(join(f.tx.commonDir, "objects", prefix))[0];
    const incoming = readFileSync(join(f.tx.commonDir, "objects", prefix, name));
    const directory = join(f.snapshot.commonDir, "objects", prefix);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, name), existing = deflateSync(inflateSync(incoming), { level: 0 });
    writeFileSync(target, existing);
    const identity = fs.statSync(target);
    const original = fs.readSync;
    let changed = false;
    const mocked = t.mock.method(fs, "readSync", (...args) => {
      const count = original(...args);
      const stat = fs.fstatSync(args[0]);
      if (!changed && stat.ino === identity.ino && stat.dev === identity.dev) {
        changed = true;
        if (kind === "replace") { rmSync(target); writeFileSync(target, existing); }
        if (kind === "grow") appendFileSync(target, Buffer.alloc(1024));
        if (kind === "hardlink") linkSync(target, join(f.root, "linked-object"));
      }
      return count;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => publishGitTransaction(f.tx), /Conflicting Git object/, kind);
      assert.equal(changed, true);
      assert.equal(f.git("diff", "--cached", "--name-only"), "");
      assert.equal(existsSync(join(f.snapshot.gitDir, "index.lock")), false);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("incoming objects must still match their Git OID", async t => {
  const f = await fixture(t); f.worker();
  const prefix = readdirObjectPrefix(f.tx.commonDir);
  const name = readdirSync(join(f.tx.commonDir, "objects", prefix))[0];
  const target = join(f.tx.commonDir, "objects", prefix, name);
  rmSync(target); // Git creates read-only objects; replace only this disposable fixture.
  writeFileSync(target, deflateSync(Buffer.from("blob 9\0rejected\n")));
  assert.throws(() => publishGitTransaction(f.tx), /content does not match its ID/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

function readdirObjectPrefix(root) {
  return readdirSync(join(root, "objects")).find(name => /^[a-f0-9]{2}$/.test(name));
}


test("fetch publishes bounded unpacked objects and exactly its tracking ref, preserving HEAD, index and dirty files", async t => {
  const f = await fixture(t); closeGitTransaction(f.tx);
  f.git("add", "file"); f.git("commit", "-m", "initial");
  const original = f.git("rev-parse", "HEAD"), index = readFileSync(join(f.cwd, ".git/index"));
  f.git("remote", "add", "origin", "https://git.example.com/repo.git");
  const remote = join(f.root, "remote");
  execFileSync("/usr/bin/git", ["clone", "--no-hardlinks", f.cwd, remote], { stdio: "pipe" });
  const remoteGit = (...args) => execFileSync("/usr/bin/git", args, { cwd: remote, encoding: "utf8", stdio: "pipe" }).trim();
  remoteGit("config", "user.name", "Fixture"); remoteGit("config", "user.email", "fixture@example.com");
  // More than Git's default unpack limit: this would produce packs without the fixed policy.
  for (let i = 0; i < 120; i++) writeFileSync(join(remote, `new-${i}`), `object ${i}\n`);
  remoteGit("add", "."); remoteGit("commit", "-m", "remote update");
  const tip = remoteGit("rev-parse", "HEAD");
  writeFileSync(join(f.cwd, "file"), "preserve local edits\n");
  const request = { operation: "fetch", remote: "origin", branch: "main", reason: "fixture" };
  const snapshot = await inspectGit(f.cwd, request), tx = createGitTransaction(snapshot, request);
  t.after(() => closeGitTransaction(tx));
  // Only the fixture transport is local; production request validation still requires HTTPS.
  const args = gitOperationArgs(request, snapshot); args[args.length - 2] = remote;
  execFileSync("/usr/bin/git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: f.cwd, stdio: "pipe", env: { ...process.env, GIT_DIR: tx.gitDir, GIT_COMMON_DIR: tx.commonDir, GIT_WORK_TREE: f.cwd } });
  assert.equal(f.git("rev-parse", "HEAD"), original);
  publishGitTransaction(tx);
  assert.equal(f.git("rev-parse", "refs/remotes/origin/main"), tip);
  assert.equal(f.git("rev-parse", "HEAD"), original);
  assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), index);
  assert.equal(readFileSync(join(f.cwd, "file"), "utf8"), "preserve local edits\n");
  assert.equal(f.git("show", `${tip}:new-119`), "object 119");
  f.git("fsck", "--no-reflogs", "--no-dangling");
});
