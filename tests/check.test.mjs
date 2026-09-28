import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheck } from "../scripts/check.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("check: fichier .mjs valide et propre => ok", async () => {
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

test("check: erreur de syntaxe détectée", async () => {
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

test("check: espace en fin de ligne et absence de retour à la ligne final détectés", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "trailing.mjs"), "export const value = 1;   \nexport const other = 2;");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, false);
    assert.ok(result.messages.some((m) => m.includes("en fin de ligne")));
    assert.ok(result.messages.some((m) => m.includes("pas de retour à la ligne final")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: tabulation d'indentation en début de ligne est un style légitime, pas une erreur", async () => {
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

test("check: tabulation traînante en fin de ligne reste détectée", async () => {
  const dir = await makeTmpDir("pi-agent-check-");
  await writeFile(join(dir, "trailing-tab.mjs"), "export const value = 1;\t\n");
  try {
    const result = runCheck({ dir, skipGitDiff: true });
    assert.equal(result.ok, false);
    assert.ok(result.messages.some((m) => m.includes("en fin de ligne")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: ignore les répertoires vendorisés", async () => {
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
