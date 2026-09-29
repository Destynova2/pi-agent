import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../core.ts";
import { chooseIndexRoot, nestedRepositories } from "../repositories.ts";

async function fixture(work: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-nested-test-")));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("detects .git file and .jj directory without following symlinks/caches", async () => fixture(async (root) => {
  await mkdir(join(root, "worktree"));
  await writeFile(join(root, "worktree/.git"), "gitdir: /fake");
  await mkdir(join(root, "jj/.jj"), { recursive: true });
  await mkdir(join(root, "node_modules/hidden/.git"), { recursive: true });
  await symlink(join(root, "jj"), join(root, "link"));
  assert.deepEqual(await nestedRepositories(root), { roots: [join(root, "jj"), join(root, "worktree")], incomplete: false });
  assert.equal((await nestedRepositories(root, undefined, 1)).incomplete, true);
}));

test("automatic simple repository; directory without a repository ignored", async () => fixture(async (root) => {
  assert.equal(await chooseIndexRoot(root, new Set()), undefined);
  await command("git", ["init", "-q"], root);
  assert.equal(await chooseIndexRoot(root, new Set()), root);
}));

test("nested repository: confirmation required, refusal and remembered approval", async () => fixture(async (root) => {
  await command("git", ["init", "-q"], root);
  const child = join(root, "child");
  await mkdir(child);
  await command("git", ["init", "-q"], child);
  await assert.rejects(chooseIndexRoot(root, new Set()), /Confirmation required/);
  assert.equal(await chooseIndexRoot(root, new Set(), async () => undefined), undefined);
  const approved = new Set<string>();
  let questions = 0;
  const choose = async (_title: string, options: string[]) => { questions++; return options[1]; };
  assert.equal(await chooseIndexRoot(root, approved, choose), root);
  assert.equal(await chooseIndexRoot(root, approved, choose), root);
  assert.equal(questions, 1);
  await mkdir(join(root, "new/.jj"), { recursive: true });
  await chooseIndexRoot(root, approved, choose);
  assert.equal(questions, 2);
}));

test("choosing a sub-project, from a repository or a parent directory", async () => fixture(async (root) => {
  const child = join(root, "child");
  await mkdir(child);
  await command("git", ["init", "-q"], child);
  const choose = async (_title: string, options: string[]) => options.find((value) => value === `Choose ${child}`);
  assert.equal(await chooseIndexRoot(root, new Set(), choose), child);
  await command("git", ["init", "-q"], root);
  assert.equal(await chooseIndexRoot(root, new Set(), choose), child);
}));

test("incomplete exploration: never treated as an absence of sub-repositories", async () => fixture(async (root) => {
  await command("git", ["init", "-q"], root);
  await mkdir(join(root, ...Array.from({ length: 10 }, () => "deep")), { recursive: true });
  await assert.rejects(chooseIndexRoot(root, new Set()), /Confirmation required/);
  let questions = 0;
  const approved = new Set<string>();
  const choose = async (title: string, options: string[]) => {
    assert.match(title, /partial/);
    questions++;
    return options[1];
  };
  await chooseIndexRoot(root, approved, choose);
  await chooseIndexRoot(root, approved, choose);
  assert.equal(questions, 2);
}));

test("cancellation of the scan respected", async () => fixture(async (root) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(nestedRepositories(root, controller.signal));
}));
