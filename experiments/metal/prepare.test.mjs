import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeReleaseLock, prepare } from "./prepare.mjs";

test("preparation refuses a different upstream lockfile", () => {
  assert.throws(() => normalizeReleaseLock('[[package]]\nname = "dependency"\nversion = "0.0.0"\n'), /unexpected upstream lockfile/);
});

test("preparation refuses existing checkouts without touching their files", () => {
  const root = mkdtempSync(join(tmpdir(), "metal-prepare-test-"));
  try {
    const sentinel = join(root, "keep"); writeFileSync(sentinel, "user work");
    assert.throws(() => prepare(root), /Destination must not exist/);
    assert.equal(readFileSync(sentinel, "utf8"), "user work");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation requires an explicit canonical absolute destination", () => {
  for (const path of ["relative", "/tmp/../tmp/proposed"]) assert.throws(() => prepare(path), /canonical absolute/);
});
