import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("missing Pi SDK fails once before executing tests, without affecting standalone fixtures", async () => {
  const root = await makeTmpDir("pi-agent-test-preflight-");
  try {
    await writeFile(join(root, "probe.test.mjs"), 'throw new Error("fixture executed");\n');
    const runner = fileURLToPath(new URL("../scripts/test.mjs", import.meta.url));
    const env = { ...process.env, PI_PACKAGE_JSON: join(root, "missing.json") };
    delete env.NODE_TEST_CONTEXT; // The child starts its own test runner.
    const blocked = spawnSync(process.execPath, [runner, "--dir", root, "--bootstrap"], { env, encoding: "utf8" });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /PI_PACKAGE_JSON.*No tests executed/);
    assert.doesNotMatch(blocked.stdout + blocked.stderr, /fixture executed/);
    const standalone = spawnSync(process.execPath, [runner, "--dir", root], { env, encoding: "utf8" });
    assert.equal(standalone.status, 1);
    assert.match(standalone.stdout + standalone.stderr, /fixture executed/);
    assert.doesNotMatch(standalone.stderr, /Pi SDK not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runner keeps native error assertions stable under an inherited French locale", async () => {
  const root = await makeTmpDir("pi-agent-test-locale-");
  try {
    await writeFile(join(root, "locale.test.mjs"), `
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("native errors use the expected diagnostic language", () => {
  const result = spawnSync("rmdir", ["missing-directory"], { cwd: import.meta.dirname, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No such file or directory/);
});
`);
    const runner = fileURLToPath(new URL("../scripts/test.mjs", import.meta.url));
    const env = { ...process.env, LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8", LANGUAGE: "fr" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, "--dir", root], { env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shouldBootstrap: real repo by default, never a fixture without asking explicitly", () => {
  assert.equal(shouldBootstrap({}), true, "no --dir => real repo => bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture" }), false, "--dir without --bootstrap => no bootstrap");
  assert.equal(shouldBootstrap({ dir: "/tmp/fixture", bootstrap: true }), true, "--dir --bootstrap => explicit, allowed");
});
