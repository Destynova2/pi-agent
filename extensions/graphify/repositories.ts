import { realpath } from "node:fs/promises";
import { nestedRepositories } from "./scope.ts";
import { NoProjectError, projectRoot } from "./core.ts";

export type ChooseRoot = (title: string, choices: string[], signal?: AbortSignal) => Promise<string | undefined>;

/** The current worktree needs no approval; explicitly including other repositories does. */
export async function chooseIndexRoot(cwd: string, approved: Set<string>, choose?: ChooseRoot, signal?: AbortSignal, includeNested = false): Promise<string | undefined> {
  let base: string;
  let isRepository = true;
  try { base = await projectRoot(cwd, signal); }
  catch (error) {
    if (!(error instanceof NoProjectError)) throw error;
    base = await realpath(cwd);
    isRepository = false;
  }
  for (let level = 0; level < 32; level++) {
    if (isRepository && !includeNested) return base;
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
