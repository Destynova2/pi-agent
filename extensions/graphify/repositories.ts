import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { NoProjectError, projectRoot } from "./core.ts";

const excluded = new Set([".git", ".jj", "node_modules", "target", ".venv", "__pycache__", ".cache"]);

/** Follows no symlinks or technical metadata/caches. Explicit limits. */
export async function nestedRepositories(root: string, signal?: AbortSignal, maxDirectories = 2000, maxDepth = 8) {
  const queue = [{ directory: root, depth: 0 }];
  const roots: string[] = [];
  let incomplete = false;
  let visited = 0;
  const deadline = Date.now() + 3000;
  while (queue.length) {
    signal?.throwIfAborted();
    if (visited++ >= maxDirectories || Date.now() > deadline) { incomplete = true; break; }
    const item = queue.shift();
    if (!item) break;
    try {
      const entries = await readdir(item.directory, { withFileTypes: true });
      if (item.directory !== root && entries.some((entry) => entry.name === ".git" || entry.name === ".jj")) {
        roots.push(item.directory);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || excluded.has(entry.name)) continue;
        if (item.depth >= maxDepth) { incomplete = true; continue; }
        queue.push({ directory: join(item.directory, entry.name), depth: item.depth + 1 });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
    }
  }
  signal?.throwIfAborted();
  return { roots: roots.sort(), incomplete };
}

export type ChooseRoot = (title: string, choices: string[], signal?: AbortSignal) => Promise<string | undefined>;

/** Any detected scope extension re-requests approval, even within the session. */
export async function chooseIndexRoot(cwd: string, approved: Set<string>, choose?: ChooseRoot, signal?: AbortSignal): Promise<string | undefined> {
  let base: string;
  let isRepository = true;
  try { base = await projectRoot(cwd, signal); }
  catch (error) {
    if (!(error instanceof NoProjectError)) throw error;
    base = await realpath(cwd);
    isRepository = false;
  }
  for (let level = 0; level < 32; level++) {
    const found = await nestedRepositories(base, signal);
    if (!found.roots.length && !found.incomplete) return isRepository ? base : undefined;
    const signature = JSON.stringify([base, found.roots, found.incomplete]);
    if (isRepository && approved.has(signature) && !found.incomplete) return base;
    if (!choose) throw new Error(`Confirmation required: nested repositories or incomplete exploration in ${base}. Open /graphify in interactive mode.`);
    const current = `Index root ${base} (sub-repositories potentially included)`;
    const candidates = found.roots.slice(0, 40);
    const choices = ["Do not index", ...(isRepository ? [current] : []), ...candidates.map((root) => `Choose ${root}`)];
    const warning = found.incomplete ? " — partial exploration, other repositories may exist" : "";
    const selected = await choose(`${found.roots.length} nested repositor${found.roots.length === 1 ? 'y' : 'ies'} in ${base}${warning}. ${found.roots.length > 40 ? 'First 40 proposed. ' : ''}Which root to map?`, choices, signal);
    signal?.throwIfAborted();
    if (isRepository && selected === current) { approved.add(signature); return base; }
    const target = candidates.find((root) => selected === `Choose ${root}`);
    if (!target) return undefined;
    if (await projectRoot(target, signal) !== target) throw new Error(`Invalid Git/jj marker in ${target}: no fallback to the parent repository.`);
    base = target;
    isRepository = true;
  }
  throw new Error("Too many levels of nested repositories: open the desired project directly.");
}
