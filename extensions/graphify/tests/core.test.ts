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
	if (process.env.PI_TEST_INTEGRATION === "1") throw new Error(`${name} absent : requis par PI_TEST_INTEGRATION=1`);
	t.skip(`${name} absent : test ignoré explicitement`);
	return false;
}

test("racine Git, séparation projets, fichiers ignorés, suppressions et aucune mutation Git", async (t) => {
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
    await assert.rejects(projectGraph(repo, "overview", "", undefined, cache), /déjà en cours/);
    await rm(lock, { recursive: true });
    await assert.rejects(projectGraph(repo, "explain", "--help", undefined, cache), /symbole/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("racine la plus proche pour jj imbriqué, Git imbriqué et colocation", async (t) => {
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

test("hors dépôt : pas d'initialisation implicite", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-graphify-no-repo-"));
  try { await assert.rejects(projectRoot(temp), /Aucune racine/); }
  finally { await rm(temp, { recursive: true, force: true }); }
});
