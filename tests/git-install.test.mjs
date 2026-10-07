import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANAGED_FILES, PACKAGE_DIRECTORY, runInstall } from "../scripts/install.mjs";
import { buildFixtureSource, makeTmpDir } from "./fixtures/build.mjs";

test("Git workers and all hook gates install together, remain executable and are backed up; linked hook parents are refused", async () => {
  const source = await buildFixtureSource(), root = await makeTmpDir("pi-git-install-"), target = join(root, "agent");
  const files = MANAGED_FILES.filter(path => path.startsWith("scripts/git-"));
  assert.deepEqual(files, ["scripts/git-operation.mjs", "scripts/git-hook-guard.mjs", ...["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"].map(name => `scripts/git-hooks/${name}`)]);
  try {
    for (const path of files) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), `fixture:${path}\n`, { mode: 0o644 });
    }
    await runInstall({ sourceRoot: source, target, noPackages: true });
    for (const path of files) {
      assert.equal(await readFile(join(target, PACKAGE_DIRECTORY, path), "utf8"), `fixture:${path}\n`);
      if (path.startsWith("scripts/git-hooks/")) assert.equal((await stat(join(target, PACKAGE_DIRECTORY, path))).mode & 0o777, 0o755);
      await writeFile(join(target, PACKAGE_DIRECTORY, path), "old\n");
    }
    const result = await runInstall({ sourceRoot: source, target, noPackages: true });
    for (const path of files) assert.equal(await readFile(join(result.backupDir, PACKAGE_DIRECTORY, path), "utf8"), "old\n");
    const outside = join(root, "outside"); await mkdir(outside);
    await rm(join(target, PACKAGE_DIRECTORY, "scripts/git-hooks"), { recursive: true });
    await symlink(outside, join(target, PACKAGE_DIRECTORY, "scripts/git-hooks"));
    await assert.rejects(runInstall({ sourceRoot: source, target, noPackages: true }), /symbolic link/);
    await assert.rejects(readFile(join(outside, "pre-commit")), { code: "ENOENT" });
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
