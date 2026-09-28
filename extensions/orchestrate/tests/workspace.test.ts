import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../../graphify/core.ts";
import { recommendedWorkspace, workspaceHint } from "../workspace.ts";

test("non configuré (par défaut) : aucune suggestion, aucun chemin personnel codé en dur", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-workspace-test-")));
  try {
    const source = join(home, "any-project");
    await mkdir(source, { recursive: true });
    await command("git", ["init", "-q"], source);
    assert.equal(await recommendedWorkspace(source, home, {}), undefined);
    assert.equal(await recommendedWorkspace(source, home, { PI_ORCHESTRATE_SOURCE_DIR: "any-project" }), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("proposer la copie configurée seulement depuis sa racine réelle, jamais basculer", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-workspace-test-")));
  const env = { PI_ORCHESTRATE_SOURCE_DIR: "workspace/source", PI_ORCHESTRATE_WORKSPACE_DIR: "workspace/source-orchestrate-jj" };
  try {
    const source = join(home, "workspace/source");
    const target = join(home, "workspace/source-orchestrate-jj");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await command("git", ["init", "-q"], source);
    assert.equal(await recommendedWorkspace(source, home, env), undefined);
    await command("git", ["init", "-q"], target);
    await command("jj", ["git", "init", "--colocate"], target);
    const before = await command("git", ["status", "--porcelain"], source);
    assert.equal(await recommendedWorkspace(source, home, env), target);
    assert.equal(await recommendedWorkspace(target, home, env), undefined);
    assert.equal(await command("git", ["status", "--porcelain"], source), before);
    assert.match(workspaceHint(target), /non commités de la source configurée/);
    assert.match(workspaceHint("/tmp/l'atelier"), /'\\''/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
