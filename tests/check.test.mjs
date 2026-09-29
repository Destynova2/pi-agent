import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheck } from "../scripts/check.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

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
