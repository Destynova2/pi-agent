import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalDialog } from "../lib/approval-dialog.ts";

test("all pages are displayed before any approval choice, with no truncated files", async () => {
  const lines = Array.from({ length: 160 }, (_, i) => `FILE-${i}: explicit-reviewed-path-${i}`), seen = [];
  const result = await approvalDialog({ ui: { select: async (title, choices) => {
    seen.push(title);
    if (choices.includes("Lire la page suivante")) {
      assert.equal(choices.includes("Autoriser cette fois"), false); return "Lire la page suivante";
    }
    return "Autoriser cette fois";
  } } }, lines.join("\n"), ["Refuser", "Autoriser cette fois"]);
  assert.equal(result, "Autoriser cette fois"); assert.ok(seen.length > 1);
  for (const line of lines) assert.ok(seen.some(page => page.includes(line)), line);
});

test("escape, premature approval and cancellation never authorize a partial review", async () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"), choices = ["Refuser", "Autoriser cette fois"];
  for (const reply of [undefined, "Refuser", "Autoriser cette fois"]) {
    assert.equal(await approvalDialog({ ui: { select: async () => reply } }, text, choices), undefined);
  }
  const controller = new AbortController();
  await assert.rejects(approvalDialog({ ui: { select: async () => { controller.abort(); return "Lire la page suivante"; } } }, text, choices, { signal: controller.signal }), /abort/i);
});

test("resizing during review restarts from page one before an approval can be consumed", async () => {
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns"), rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  try {
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"); let resized = false, restarted = false;
    const result = await approvalDialog({ ui: { select: async (title, choices) => {
      if (resized && title.includes("page 1/")) restarted = true;
      assert.ok(title.split("\n").length + choices.length + 9 <= process.stdout.rows);
      if (choices.includes("Lire la page suivante")) return "Lire la page suivante";
      if (!resized) { resized = true; Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true }); }
      return "Autoriser cette fois";
    } } }, text, ["Refuser", "Autoriser cette fois"]);
    assert.equal(result, "Autoriser cette fois"); assert.equal(restarted, true);
    Object.defineProperty(process.stdout, "rows", { value: 8, configurable: true });
    await assert.rejects(approvalDialog({ ui: { select() { assert.fail("must fit before showing approval"); } } }, text, ["Refuser", "Autoriser cette fois"]), /Enlarge the terminal/);
  } finally {
    if (columns) Object.defineProperty(process.stdout, "columns", columns); else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, "rows", rows); else delete process.stdout.rows;
  }
});
