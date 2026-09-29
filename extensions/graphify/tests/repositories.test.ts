import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../core.ts";
import { chooseIndexRoot } from "../repositories.ts";
import { nestedRepositories } from "../scope.ts";

async function fixture(work: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-nested-test-")));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("detects .git file and .jj directory; metadata and symlinks become extractor exclusions", async () => fixture(async (root) => {
  await mkdir(join(root, "worktree"));
  await writeFile(join(root, "worktree/.git"), "gitdir: /fake");
  await mkdir(join(root, "jj/.jj"), { recursive: true });
  await mkdir(join(root, "node_modules/hidden/.git"), { recursive: true });
  await symlink(join(root, "jj"), join(root, "link"));
  assert.deepEqual(await nestedRepositories(root), { roots: [join(root, "jj"), join(root, "worktree")], incomplete: false, excluded: [join(root, "link"), join(root, "node_modules")] });
  const bounded = await nestedRepositories(root, undefined, 1);
  assert.equal(bounded.incomplete, true);
  assert.ok(bounded.excluded.includes(join(root, "jj")) && bounded.excluded.includes(join(root, "worktree")));
}));

test("automatic current repository; directory without a repository ignored", async () => fixture(async (root) => {
  assert.equal(await chooseIndexRoot(root, new Set()), undefined);
  await command("git", ["init", "-q"], root);
  assert.equal(await chooseIndexRoot(root, new Set()), root);
}));

test("nested repositories need approval only when explicitly including them", async () => fixture(async (root) => {
  await command("git", ["init", "-q"], root);
  const child = join(root, "child");
  await mkdir(child);
  await command("git", ["init", "-q"], child);
  assert.equal(await chooseIndexRoot(root, new Set()), root);
  await assert.rejects(chooseIndexRoot(root, new Set(), undefined, undefined, true), /Confirmation required/);
  assert.equal(await chooseIndexRoot(root, new Set(), async () => undefined, undefined, true), undefined);
  const approved = new Set<string>();
  let questions = 0;
  const choose = async (_title: string, options: string[]) => { questions++; return options[1]; };
  assert.equal(await chooseIndexRoot(root, approved, choose, undefined, true), root);
  assert.equal(await chooseIndexRoot(root, approved, choose, undefined, true), root);
  assert.equal(questions, 1);
  await mkdir(join(root, "new/.jj"), { recursive: true });
  await chooseIndexRoot(root, approved, choose, undefined, true);
  assert.equal(questions, 2);
}));

test("choosing a sub-project from a non-repository or explicit broader selection", async () => fixture(async (root) => {
  const child = join(root, "child");
  await mkdir(child);
  await command("git", ["init", "-q"], child);
  const choose = async (_title: string, options: string[]) => options.find(value => value === `Choose ${child}`);
  assert.equal(await chooseIndexRoot(root, new Set(), choose), child);
  await command("git", ["init", "-q"], root);
  assert.equal(await chooseIndexRoot(root, new Set(), choose, undefined, true), child);
}));

test("partial scope is automatic with frontier excluded; broader scope still asks", async () => fixture(async (root) => {
  await command("git", ["init", "-q"], root);
  await mkdir(join(root, ...Array.from({ length: 10 }, () => "deep")), { recursive: true });
  assert.equal(await chooseIndexRoot(root, new Set()), root);
  const scope = await nestedRepositories(root);
  assert.ok(scope.incomplete && scope.excluded.some(path => path.includes("deep")));
  await assert.rejects(chooseIndexRoot(root, new Set(), undefined, undefined, true), /Confirmation required/);
  let questions = 0;
  const approved = new Set<string>();
  const choose = async (title: string, options: string[]) => { assert.match(title, /partial/); questions++; return options[1]; };
  await chooseIndexRoot(root, approved, choose, undefined, true);
  await chooseIndexRoot(root, approved, choose, undefined, true);
  assert.equal(questions, 2);
}));

test("internal worktrees are excluded from discovery", async () => fixture(async (root) => {
  for (const path of [".claude/worktrees/agent/.git", ".worktrees/agent/.git"]) await mkdir(join(root, path), { recursive: true });
  const scope = await nestedRepositories(root);
  assert.deepEqual(scope.roots, []);
  assert.equal(scope.incomplete, false);
  assert.ok(scope.excluded.includes(join(root, ".claude/worktrees")));
  assert.ok(scope.excluded.includes(join(root, ".worktrees")));
}));

test("cancellation of the scan respected", async () => fixture(async (root) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(nestedRepositories(root, controller.signal));
}));
