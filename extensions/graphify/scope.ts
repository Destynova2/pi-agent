import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const metadata = new Set([".git", ".jj", "node_modules", "target", ".venv", "__pycache__", ".cache"]);
// Applied to the extractor even when the bounded scan cannot reach these paths.
export const WORKTREE_EXCLUDES = [".worktrees/", "**/.*/worktrees/"];

/** A bounded scan is safe only if the extractor also excludes every unexplored subtree. */
export async function nestedRepositories(root: string, signal?: AbortSignal, maxDirectories = 2000, maxDepth = 8) {
  const queue = [{ directory: root, depth: 0 }];
  const roots: string[] = [];
  const excluded: string[] = [];
  let incomplete = false;
  let visited = 0;
  const deadline = Date.now() + 3000;
  while (queue.length) {
    signal?.throwIfAborted();
    if (visited++ >= maxDirectories || Date.now() > deadline) {
      incomplete = true;
      excluded.push(...queue.map(item => item.directory));
      break;
    }
    const item = queue.shift()!;
    try {
      const entries = await readdir(item.directory, { withFileTypes: true });
      if (item.directory !== root && entries.some(entry => entry.name === ".git" || entry.name === ".jj")) {
        roots.push(item.directory);
        continue;
      }
      for (const entry of entries) {
        const target = join(item.directory, entry.name);
        if (entry.isSymbolicLink()) { excluded.push(target); continue; }
        if (!entry.isDirectory()) continue;
        if (metadata.has(entry.name) || entry.name === ".worktrees" ||
            (entry.name === "worktrees" && basename(item.directory).startsWith("."))) {
          excluded.push(target);
          continue;
        }
        if (item.depth >= maxDepth) { incomplete = true; excluded.push(target); continue; }
        queue.push({ directory: target, depth: item.depth + 1 });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (item.directory === root) throw error;
      incomplete = true;
      excluded.push(item.directory);
    }
  }
  signal?.throwIfAborted();
  return { roots: roots.sort(), incomplete, excluded: excluded.sort() };
}
