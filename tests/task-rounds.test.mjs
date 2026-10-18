import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROUNDS, nextRound } from "../extensions/task-progress/index.ts";

const state = (...statuses) => ({ version: 1, cwd: "/p", task: "t", items: statuses.map((status, i) => ({ id: `r${i}`, requirement: "req", status, evidence: status === "pending" || status === "in_progress" ? undefined : "e" })) });

test("rounds continue only while items are open, progress is made and the budget remains", () => {
  const rounds = { max: 2, used: 0 };
  assert.match(nextRound(rounds, state("pending", "done")).message, /round 1\/2.*r0 \(pending\)/);
  assert.equal(rounds.used, 1);
  assert.match(nextRound(rounds, state("pending", "done")).stop, /changed no checkpoint item/, "same items twice: no progress");
  const progressed = { max: 2, used: 1, last: JSON.stringify(state("pending", "done").items) };
  assert.match(nextRound(progressed, state("in_progress", "done")).message, /round 2\/2/);
  assert.match(nextRound(progressed, state("done", "pending")).stop, /2-round budget/);
  assert.match(nextRound({ max: 3, used: 0 }, state("blocked", "deferred", "done")).stop, /done, blocked or deferred/);
  assert.match(nextRound({ max: 3, used: 0 }, undefined).stop, /done, blocked or deferred/);
  assert.equal(MAX_ROUNDS, 10);
});
