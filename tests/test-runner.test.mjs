import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectTests, shouldBootstrap } from "../scripts/test.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("collecte les .test.ts et .test.mjs hors vendor, exclut les .integration.test.* par défaut", async () => {
  const root = await makeTmpDir("pi-agent-testrunner-");
  await mkdir(join(root, "sub", "node_modules"), { recursive: true });
  await writeFile(join(root, "a.test.mjs"), "");
  await writeFile(join(root, "sub", "b.test.ts"), "");
  await writeFile(join(root, "sub", "c.integration.test.mjs"), "");
  await writeFile(join(root, "sub", "node_modules", "ignored.test.mjs"), "");
  await writeFile(join(root, "sub", "not-a-test.mjs"), "");
  try {
    const standard = collectTests(root, { integration: false });
    assert.deepEqual(
      standard.map((f) => f.replace(`${root}/`, "")).sort(),
      ["a.test.mjs", "sub/b.test.ts"],
    );
    const integration = collectTests(root, { integration: true });
    assert.deepEqual(
      integration.map((f) => f.replace(`${root}/`, "")),
      ["sub/c.integration.test.mjs"],
    );
    const all = collectTests(root, { all: true });
    assert.deepEqual(
      all.map((f) => f.replace(`${root}/`, "")).sort(),
      ["a.test.mjs", "sub/b.test.ts", "sub/c.integration.test.mjs"],
      "--integration exécute la suite ENTIÈRE, rien n'est exclu ni filtré",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shouldBootstrap : dépôt réel par défaut, jamais une fixture sans le demander explicitement", () => {
  assert.equal(shouldBootstrap({}), true, "pas de --dir => dépôt réel => bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture" }), false, "--dir sans --bootstrap => pas de bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture", bootstrap: true }), true, "--dir --bootstrap => explicite, autorisé");
});
