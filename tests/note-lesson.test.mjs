import assert from "node:assert/strict";
import { test } from "node:test";
import register, { isLesson, LESSON_FORMAT } from "../extensions/notes.ts";

test("a lesson is stored only with cue, lesson and evidence", async () => {
  assert.ok(isLesson("cue: verify fails with 'Inputs changed' | lesson: finish edits before running verify | evidence: two reruns on 2026-10-17"));
  assert.ok(isLesson("CUE: x | Lesson: y | Evidence: z"));
  for (const body of ["be thorough", "cue: x | lesson: y", "cue: | lesson: y | evidence: z", "lesson: y | cue: x | evidence: z"]) assert.equal(isLesson(body), false, body);
  let tool;
  register({ on() {}, registerTool: value => { if (value.name === "note_add") tool = value; }, registerCommand() {}, registerShortcut() {}, getActiveTools: () => [], sendMessage() {}, appendEntry() {} });
  await assert.rejects(tool.execute("1", { kind: "lesson", body: "be thorough" }), new RegExp(LESSON_FORMAT.slice(0, 14)));
  assert.match(tool.parameters.properties.body.description, /cue:/);
});
