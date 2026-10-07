import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheck } from "../scripts/check.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("check reuses only successful identical inputs, invalidating additions, edits and SDK changes", async t => {
  const parent = await makeTmpDir("pi-check-evidence-"), dir = join(parent, "source"), evidence = join(parent, "check.json");
  await mkdir(dir);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sdk = join(parent, "sdk.json");
  await writeFile(sdk, "{}\n");
  await mkdir(join(parent, "dist/bundle"), { recursive: true });
  const cli = join(parent, "dist/bundle/cli.js");
  await writeFile(cli, "// SDK CLI\n");
  const oldSdk = process.env.PI_PACKAGE_JSON;
  process.env.PI_PACKAGE_JSON = sdk;
  try {
    await writeFile(join(dir, "entry.mjs"), "export const ok = 1;\n");
    const check = () => runCheck({ dir, skipGitDiff: true, evidence, reuseEvidence: evidence });
    assert.equal(check().reused, false);
    assert.equal(check().reused, true);
    await writeFile(join(dir, "view.ts"), "export const view = 2;\n");
    assert.equal(check().reused, false);
    assert.equal(check().reused, true);
    await writeFile(sdk, '{"version":"changed"}\n');
    assert.equal(check().reused, false);
    await writeFile(cli, "// changed SDK CLI\n");
    assert.equal(check().reused, false);
    await writeFile(join(dir, "added.mjs"), "export const broken = (;\n");
    assert.equal(check().ok, false);
    assert.equal(check().reused, false, "failures never become reusable");
    await writeFile(join(dir, "added.mjs"), "export const fixed = 3;\n");
    assert.equal(check().ok, true);
    assert.equal(check().reused, true);
    await writeFile(evidence, "{");
    assert.equal(check().reused, false);
    assert.equal(JSON.parse(await readFile(evidence, "utf8")).ok, true);
    const gitFailure = runCheck({ dir, reuseEvidence: evidence });
    assert.equal(gitFailure.reused, true);
    assert.equal(gitFailure.ok, false, "Git validation still runs after syntax evidence reuse");
  } finally {
    if (oldSdk === undefined) delete process.env.PI_PACKAGE_JSON;
    else process.env.PI_PACKAGE_JSON = oldSdk;
  }
});

test("check: valid and clean .mjs file => ok", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "clean.mjs"), "export const value = 1;\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: syntax error detected", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "broken.mjs"), "export const value = (;\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, false);
    assert.ok(result.messages.some((m) => m.includes("broken.mjs")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: trailing whitespace and missing final newline detected", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "trailing.mjs"), "export const value = 1;   \nexport const other = 2;");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, false);
    assert.ok(result.messages.some((m) => m.includes("end of line")));
    assert.ok(result.messages.some((m) => m.includes("missing final newline")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: leading indentation tab is a legitimate style, not an error", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "tabs.mjs"), "export function f() {\n\treturn 1;\n}\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: trailing tab at end of line is still detected", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "trailing-tab.mjs"), "export const value = 1;\t\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, false);
    assert.ok(result.messages.some((m) => m.includes("end of line")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: ignores vendored directories", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await writeFile(join(dir, "node_modules", "broken.mjs"), "export const v = (;\n");
  await writeFile(join(dir, "clean.mjs"), "export const value = 1;\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
