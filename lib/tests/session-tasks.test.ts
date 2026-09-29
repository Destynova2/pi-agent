import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionTasks } from "../session-tasks.ts";

test("fermeture de session : annuler et attendre les nettoyages concurrents", async () => {
  const tasks = new SessionTasks();
  let cleaned = 0;
  const work = (signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => setTimeout(() => { cleaned++; resolve(); }, 20), { once: true });
  });
  const first = tasks.run(work);
  const second = tasks.run(work);
  await tasks.close();
  assert.equal(cleaned, 2);
  await Promise.all([first, second]);
  await tasks.close();
  await assert.rejects(tasks.run(work));
});

test("external signal already aborted: never start an operation", async () => {
  const tasks = new SessionTasks();
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(tasks.run(async () => { started = true; }, controller.signal));
  assert.equal(started, false);
  await tasks.close();
});
