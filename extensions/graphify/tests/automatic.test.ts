import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticIndex } from "../automatic.ts";

test("non-blocking start, single task and explicit wait", async () => {
  const automatic = new AutomaticIndex<number>();
  let finish: ((value: number) => void) | undefined;
  let calls = 0;
  let result = 0;
  let unexpected = 0;
  const bad = () => { unexpected++; };
  const work = () => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); };
  automatic.start(work, (value) => { result = value; }, bad);
  automatic.start(work, bad, bad);
  assert.equal(calls, 1);
  assert.equal(result, 0);
  assert.ok(finish);
  finish(42);
  await automatic.wait();
  assert.equal(result, 42);
  await automatic.close();
  assert.equal(unexpected, 0);
});

test("transition: expected cancellation, no late notification", async () => {
  const automatic = new AutomaticIndex<void>();
  let cleaned = false;
  let notifications = 0;
  automatic.start((signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { cleaned = true; reject(new Error("canceled")); }, { once: true });
  }), () => { notifications++; }, () => { notifications++; });
  await automatic.close();
  assert.equal(cleaned, true);
  assert.equal(notifications, 0);
  let restarted = false;
  automatic.start(async () => { restarted = true; }, () => { notifications++; }, () => { notifications++; });
  await automatic.wait();
  assert.equal(restarted, false);
  assert.equal(notifications, 0);
});

test("indexing failure reported once with no unhandled rejection", async () => {
  const automatic = new AutomaticIndex<void>();
  let failures = 0;
  let completed = false;
  automatic.start(async () => { throw new Error("Graphify missing"); }, () => { completed = true; }, () => { failures++; });
  await automatic.wait();
  assert.equal(failures, 1);
  assert.equal(completed, false);
  await automatic.close();
});
