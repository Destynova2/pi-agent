/**
 * graphify worker -- the only module this extension's host files (index.ts, repositories.ts) may
 * call to detect a Git/jj root, scan for nested repositories, or run the actual AST indexing
 * (shelling out to `graphify extract`, reading the whole worktree, writing the cache). The parent's
 * launcher (lib/confined.ts) invokes executeGraphify in a confined process, including startup
 * indexing and root discovery. There is no in-process fallback.
 *
 * Contract: every input carries the path(s) it operates on explicitly (never ambient cwd), so a
 * jail can validate each one against the session root before this code runs. Results never throw
 * the library's own Error subclasses across the boundary (they would not survive a real process
 * hop); "no project" is a discriminated `ok: false` result instead.
 */

import { NoProjectError, projectGraph, projectRoot, type GraphAction } from "./core.ts";
import { nestedRepositories } from "./scope.ts";

export type GraphifyInput =
	| { op: "root"; cwd: string }
	| { op: "scan"; root: string; maxDirectories?: number; maxDepth?: number }
	| { op: "graph"; root: string; action: GraphAction; symbol?: string; includeNested?: boolean; cacheBase?: string };

export type GraphifyResult =
	| { op: "root"; ok: true; root: string }
	| { op: "root"; ok: false; error: "no-project"; message: string }
	| { op: "scan"; ok: true; roots: string[]; incomplete: boolean; excluded: string[] }
	| { op: "graph"; ok: true; root: string; graph: string; text: string }
	| { op: "graph"; ok: false; error: "no-project"; message: string };

export async function executeGraphify(input: GraphifyInput, signal?: AbortSignal): Promise<GraphifyResult> {
	switch (input.op) {
		case "root": {
			try {
				return { op: "root", ok: true, root: await projectRoot(input.cwd, signal) };
			} catch (error) {
				if (error instanceof NoProjectError) return { op: "root", ok: false, error: "no-project", message: error.message };
				throw error;
			}
		}
		case "scan": {
			const scope = await nestedRepositories(input.root, signal, input.maxDirectories, input.maxDepth);
			return { op: "scan", ok: true, ...scope };
		}
		case "graph": {
			try {
				const result = await projectGraph(input.root, input.action, input.symbol ?? "", signal, input.cacheBase, input.includeNested);
				return { op: "graph", ok: true, ...result };
			} catch (error) {
				if (error instanceof NoProjectError) return { op: "graph", ok: false, error: "no-project", message: error.message };
				throw error;
			}
		}
	}
}
