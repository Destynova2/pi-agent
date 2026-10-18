import { test } from "node:test";
import assert from "node:assert/strict";
import { observeFile, readBeforeEdit } from "../lib/confined-tools.ts";

test("edit is blocked until a read or write of the same file succeeded in this session", () => {
  const observed = new Set();
  assert.match(readBeforeEdit(observed, "edit", { path: "src/a.ts" }, "/p"), /Read src\/a.ts with the read tool/);
  observeFile(observed, "read", { path: "src/a.ts", offset: 999999 }, "/p", true);
  assert.match(readBeforeEdit(observed, "edit", { path: "src/a.ts" }, "/p"), /src\/a.ts/, "a failed read teaches nothing");
  observeFile(observed, "read", { path: "src/a.ts" }, "/p", false);
  assert.equal(readBeforeEdit(observed, "edit", { path: "/p/src/a.ts" }, "/p"), undefined, "relative and absolute spellings match");
  assert.match(readBeforeEdit(observed, "edit", { path: "src/b.ts" }, "/p"), /src\/b.ts/);
  observeFile(observed, "write", { path: "src/b.ts" }, "/p", false);
  assert.equal(readBeforeEdit(observed, "edit", { path: "src/b.ts" }, "/p"), undefined, "a written file is known");
  observeFile(observed, "bash", { path: "src/c.ts" }, "/p", false);
  assert.match(readBeforeEdit(observed, "edit", { path: "src/c.ts" }, "/p"), /src\/c.ts/, "only read and write count");
  assert.equal(readBeforeEdit(observed, "edit", {}, "/p"), undefined, "no path: left to the tool's own validation");
  assert.equal(readBeforeEdit(observed, "bash", { path: "x" }, "/p"), undefined);
});
