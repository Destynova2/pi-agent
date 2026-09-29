import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { cacheDirectory, command, projectGraph, projectRoot } from "../core.ts";

// Explicit skip only when the real binary is absent from PATH; PI_TEST_INTEGRATION=1 forces a
// hard failure instead, so CI cannot silently pass without ever exercising this suite.
function onPath(name: string): boolean {
	return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
function requireDependency(t: { skip: (msg: string) => void }, name: string): boolean {
	if (onPath(name)) return true;
	if (process.env.PI_TEST_INTEGRATION === "1") throw new Error(`${name} missing: required by PI_TEST_INTEGRATION=1`);
	t.skip(`${name} missing: test explicitly skipped`);
	return false;
}

test("Git root, project separation, ignored files, deletions and no Git mutation", async (t) => {
	if (!requireDependency(t, "git") || !requireDependency(t, "graphify")) return;
  const temp = await mkdtemp(join(tmpdir(), "pi-graphify-test-"));
  try {
    const repo = join(temp, "repo");
    const cache = join(temp, "cache");
    await mkdir(join(repo, "src"), { recursive: true });
    await command("git", ["init", "-q", repo], temp);
    await writeFile(join(repo, ".gitignore"), "ignored.rs\n");
    await writeFile(join(repo, "ignored.rs"), "fn secret_ignored() {}\n");
    await writeFile(join(repo, "src", "lib.rs"), "pub fn entry() { helper(); }\nfn helper() {}\n");
    const root = await projectRoot(join(repo, "src"));
    assert.equal(root, await projectRoot(repo));
    assert.notEqual(cacheDirectory(root), cacheDirectory(`${root}-other`));
    const before = await command("git", ["status", "--porcelain"], repo);
    const result = await projectGraph(join(repo, "src"), "explain", "entry", undefined, cache);
    assert.match(result.text, /entry/);
    const graph = await readFile(result.graph, "utf8");
    assert.match(graph, /helper/);
    assert.doesNotMatch(graph, /secret_ignored/);
    assert.equal(await command("git", ["status", "--porcelain"], repo), before);
    await writeFile(join(repo, "src", "lib.rs"), "pub fn replacement() {}\n");
    const updated = await projectGraph(repo, "overview", "", undefined, cache);
    assert.doesNotMatch(await readFile(updated.graph, "utf8"), /helper/);
    const lock = join(cacheDirectory(root, cache), "index.lock");
    await mkdir(lock);
    await assert.rejects(projectGraph(repo, "overview", "", undefined, cache), /already in progress/);
    await rm(lock, { recursive: true });
    await assert.rejects(projectGraph(repo, "explain", "--help", undefined, cache), /symbol/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("closest root for nested jj, nested Git and colocation", async (t) => {
  if (!requireDependency(t, "git") || !requireDependency(t, "jj")) return;
  const temp = await mkdtemp(join(tmpdir(), "pi-roots-test-"));
  try {
    await command("git", ["init", "-q"], temp);
    const inner = join(temp, "jj");
    await command("jj", ["git", "init", "--no-colocate", inner], temp);
    assert.equal(await projectRoot(inner), await realpath(inner));
    const git = join(inner, "git");
    await mkdir(git);
    await command("git", ["init", "-q"], git);
    assert.equal(await projectRoot(git), await realpath(git));
    await command("jj", ["git", "init", "--colocate"], git);
    assert.equal(await projectRoot(git), await realpath(git));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("worktree-only extraction excludes nested repositories, internal worktrees and unexplored subtrees, including warm caches", async (t) => {
  if (!requireDependency(t, "git") || !requireDependency(t, "graphify")) return;
  const temp = await mkdtemp(join(tmpdir(), "pi-graph-scope-"));
  try {
    const root = join(temp, "repo");
    const cache = join(temp, "cache");
    await mkdir(join(root, "src"), { recursive: true });
    await command("git", ["init", "-q"], root);
    await writeFile(join(root, "src/main.rs"), "pub fn current_root_fixture() {}\n");
    await command("git", ["add", "src/main.rs"], root);
    await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], root);
    const child = join(root, "child [repo]");
    await mkdir(child);
    await writeFile(join(child, "lib.rs"), "pub fn nested_root_fixture() {}\n");
    const initial = await projectGraph(root, "overview", "", undefined, cache);
    assert.match(await readFile(initial.graph, "utf8"), /nested_root_fixture/);
    await command("git", ["init", "-q"], child);
    const worktree = join(root, ".claude/worktrees/agent");
    await command("git", ["worktree", "add", "--detach", worktree, "HEAD"], root);
    await writeFile(join(worktree, "src/main.rs"), "pub fn other_worktree_fixture() {}\n");
    const deep = join(root, ...Array.from({ length: 10 }, () => "deep"));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "lib.rs"), "pub fn beyond_scope_fixture() {}\n");
    const before = await command("git", ["status", "--porcelain"], root);
    const scoped = await projectGraph(root, "overview", "", undefined, cache);
    const graph = await readFile(scoped.graph, "utf8");
    assert.match(graph, /current_root_fixture/);
    assert.doesNotMatch(graph, /nested_root_fixture|other_worktree_fixture|beyond_scope_fixture/);
    assert.match(scoped.text, /partial scope scan, unexplored subtrees excluded/);
    const broader = await projectGraph(root, "overview", "", undefined, cache, true);
    assert.match(await readFile(broader.graph, "utf8"), /nested_root_fixture/);
    assert.doesNotMatch(await readFile(broader.graph, "utf8"), /other_worktree_fixture|beyond_scope_fixture/);
    const narrowed = await projectGraph(root, "overview", "", undefined, cache);
    assert.doesNotMatch(await readFile(narrowed.graph, "utf8"), /nested_root_fixture/);
    const ownWorktree = await projectGraph(worktree, "overview", "", undefined, cache);
    assert.match(await readFile(ownWorktree.graph, "utf8"), /other_worktree_fixture/);
    assert.notEqual(ownWorktree.graph, scoped.graph);
    assert.equal(await command("git", ["status", "--porcelain"], root), before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("outside a repository: no implicit initialization", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-graphify-no-repo-"));
  try { await assert.rejects(projectRoot(temp), /No Git\/jj root/); }
  finally { await rm(temp, { recursive: true, force: true }); }
});
