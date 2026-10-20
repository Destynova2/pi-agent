import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

/** A live SQLite transaction owns the lock; process death releases it without stale-lock guessing. */
export async function withIndexLock<T>(cache: string, work: () => Promise<T>, signal?: AbortSignal, waitMs = 120_000): Promise<T> {
  signal?.throwIfAborted();
  const legacy = join(cache, "index.lock");
  try {
    await lstat(legacy);
    // Old workers do not participate in the new lock. Never steal their directory.
    throw new Error(`Legacy Graphify lock: ${legacy}. Verify that old indexing workers have stopped before removing this marker.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const path = join(cache, "index.sqlite");
  const db = new DatabaseSync(path, { timeout: 0 });
  let acquired = false;
  const deadline = performance.now() + waitMs;
  try {
    await chmod(path, 0o600);
    while (!acquired) {
      signal?.throwIfAborted();
      try {
        db.exec("BEGIN IMMEDIATE");
        acquired = true;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error; // SQLITE_BUSY only
        if (performance.now() >= deadline) throw new Error("Graphify indexing is still running; timed out waiting for its cache lock.");
        await delay(Math.min(100, Math.max(1, deadline - performance.now())), undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    return await work();
  } finally {
    try { if (acquired) db.exec("ROLLBACK"); }
    finally { db.close(); }
    // Keep this file: unlinking a live SQLite lock can give two writers different inodes.
  }
}
