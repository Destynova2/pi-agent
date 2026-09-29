import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectTests, shouldBootstrap } from "../scripts/test.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("collects .test.ts and .test.mjs outside vendor, excludes .integration.test.* by default", async () => {
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
      "--integration runs the ENTIRE suite, nothing is excluded or filtered",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shouldBootstrap: real repo by default, never a fixture without asking explicitly", () => {
  assert.equal(shouldBootstrap({}), true, "no --dir => real repo => bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture" }), false, "--dir without --bootstrap => no bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture", bootstrap: true }), true, "--dir --bootstrap => explicit, allowed");
});
