import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withIndexLock } from "../lock.ts";

function owner(cache: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This is a standalone worker, not a nested test runner.
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/lock-owner.mjs", import.meta.url)), cache], { env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Lock owner exited before ready: ${code}/${signal}: ${stderr}`)));
    child.stdout.once("data", chunk => {
      if (chunk.toString().includes("locked")) resolve();
      else reject(new Error(`Unexpected owner output: ${chunk.toString()}`));
    });
  });
  return { child, exited, ready };
}

test("a live owner serializes callers; timeout and cancellation never steal its lock", { timeout: 10_000 }, async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-index-lock-"));
  const { child, exited, ready } = owner(cache);
  try {
    await ready;
    let entered = false;
    await assert.rejects(withIndexLock(cache, async () => { entered = true; }, undefined, 30), /timed out/);
    await assert.rejects(withIndexLock(cache, async () => { entered = true; }, AbortSignal.timeout(30)), /abort/i);
    assert.equal(entered, false);
    const waiting = withIndexLock(cache, async () => { entered = true; return "next"; });
    child.stdin.end();
    assert.equal(await waiting, "next");
    assert.equal(entered, true);
    assert.equal((await exited)[0], 0);
    assert.equal((await stat(join(cache, "index.sqlite"))).mode & 0o777, 0o600);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(cache, { recursive: true, force: true });
  }
});

test("SIGKILL releases the lock without deleting files or guessing a stale PID", { timeout: 10_000 }, async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-index-crash-"));
  const { child, exited, ready } = owner(cache);
  try {
    await ready;
    const inode = (await stat(join(cache, "index.sqlite"))).ino;
    child.kill("SIGKILL");
    assert.equal((await exited)[1], "SIGKILL");
    assert.equal(await withIndexLock(cache, async () => "recovered"), "recovered");
    assert.equal((await stat(join(cache, "index.sqlite"))).ino, inode);
    await assert.rejects(withIndexLock(cache, async () => { throw new Error("extract failed"); }), /extract failed/);
    assert.equal(await withIndexLock(cache, async () => "after failure"), "after failure");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(cache, { recursive: true, force: true });
  }
});

test("corrupt lock storage fails explicitly without running the indexer", async () => {
  const cache = await mkdtemp(join(tmpdir(), "pi-index-corrupt-"));
  try {
    await writeFile(join(cache, "index.sqlite"), "not a database\n");
    await assert.rejects(withIndexLock(cache, async () => assert.fail("must not index")), /not a database/);
  } finally { await rm(cache, { recursive: true, force: true }); }
});
