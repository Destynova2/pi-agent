import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../../graphify/core.ts";
import { recommendedWorkspace, workspaceHint } from "../workspace.ts";

test("proposer la copie reti seulement depuis sa racine réelle, jamais basculer", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-workspace-test-")));
  try {
    const source = join(home, "workspace/reti");
    const target = join(home, "workspace/reti-orchestrate-jj");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await command("git", ["init", "-q"], source);
    assert.equal(await recommendedWorkspace(source, home), undefined);
    await command("git", ["init", "-q"], target);
    await command("jj", ["git", "init", "--colocate"], target);
    const before = await command("git", ["status", "--porcelain"], source);
    assert.equal(await recommendedWorkspace(source, home), target);
    assert.equal(await recommendedWorkspace(target, home), undefined);
    assert.equal(await command("git", ["status", "--porcelain"], source), before);
    assert.match(workspaceHint(target), /non commités/);
    assert.match(workspaceHint("/tmp/l'atelier"), /'\\''/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
