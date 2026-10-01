import { runConfined } from "../../lib/confined.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chooseIndexRoot } from "./repositories.ts";
import type { GraphifyInput, GraphifyResult } from "./worker.ts";
import { AutomaticIndex } from "./automatic.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

async function dispatch(cwd: string, input: GraphifyInput, signal?: AbortSignal): Promise<GraphifyResult> {
  return await runConfined(cwd, "graphify", input, signal) as GraphifyResult;
}

export default function (pi: ExtensionAPI) {
  let tasks = new SessionTasks();
  let automatic = new AutomaticIndex<Extract<GraphifyResult, { op: "graph"; ok: true }> | undefined>();
  let selectedRoot: string | undefined;
  const approved = new Set<string>();
  const pickRoot = async (ctx: ExtensionContext, signal?: AbortSignal, includeNested = false) => {
    const root = await chooseIndexRoot(selectedRoot ?? ctx.cwd, approved,
      ctx.hasUI ? (title, choices, owned) => ctx.ui.select(title, choices, { signal: owned }) : undefined, signal, includeNested, ctx.cwd);
    selectedRoot = root;
    return root;
  };
  const reset = async () => {
    await Promise.all([tasks.close(), automatic.close()]);
    tasks = new SessionTasks();
    automatic = new AutomaticIndex();
    selectedRoot = undefined;
    approved.clear();
  };
  pi.on("session_start", async (_event, ctx) => {
    await reset();
    if (process.env.PI_GRAPHIFY_AUTO === "0") return;
    ctx.ui.setStatus("graphify", "AST indexing in background…");
    automatic.start(
      async (signal) => {
        const detected = await dispatch(ctx.cwd, { op: "root", cwd: ctx.cwd }, signal) as Extract<GraphifyResult, { op: "root" }>;
        if (!detected.ok) return undefined;
        selectedRoot = detected.root;
        const result = await dispatch(ctx.cwd, { op: "graph", root: detected.root, action: "overview", symbol: "" }, signal) as Extract<GraphifyResult, { op: "graph" }>;
        if (!result.ok) return undefined;
        return result;
      },
      (result) => ctx.ui.setStatus("graphify", result ? `Graphify ready: ${result.root}` : undefined),
      (error) => {
        ctx.ui.setStatus("graphify", undefined);
        ctx.ui.notify(`Automatic indexing unavailable: ${error instanceof Error ? error.message : String(error)}. /graphify allows retrying.`, "warning");
      },
    );
  });
  const beforeTransition = async (_event: unknown, ctx: ExtensionContext) => {
    await reset();
    ctx.ui.setStatus("graphify", undefined);
  };
  pi.on("session_before_switch", beforeTransition);
  pi.on("session_before_fork", beforeTransition);
  pi.on("session_before_tree", beforeTransition);
  pi.on("session_shutdown", async () => { await Promise.all([tasks.close(), automatic.close()]); });
  pi.registerTool({
    name: "project_graph",
    label: "Project map (Graphify)",
    description: "Automatic indexing at the start of a Git/jj session; this tool refreshes the map via local AST, then shows central symbols or a symbol's relations. No extra LLM call. Cache outside the repository, separated per worktree. Respects Graphify/Git ignores.",
    promptSnippet: "AST map of the Git/jj project: symbols, calls and impacts.",
    promptGuidelines: ["To explore a project, project_graph can target reads; verify sources before modifying. This graph is incomplete and does not replace tests."],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("overview"), Type.Literal("explain"), Type.Literal("affected")]),
      symbol: Type.Optional(Type.String({ description: "Symbol required for explain/affected." })),
    }),
    execute: async (_id, params, signal, _update, ctx) => {
      const result = await tasks.run(async (owned) => {
        await automatic.wait();
        owned.throwIfAborted();
        const root = await pickRoot(ctx, owned);
        if (!root) throw new Error("No authorized root: indexing canceled.");
        const graphed = await dispatch(ctx.cwd, { op: "graph", root, action: params.action, symbol: params.symbol }, owned) as Extract<GraphifyResult, { op: "graph" }>;
        if (!graphed.ok) throw new Error(graphed.message);
        return graphed;
      }, signal);
      return { content: [{ type: "text", text: result.text }], details: { root: result.root, graph: result.graph } };
    },
  });
  pi.registerCommand("graphify", {
    description: "Indexes the current Git/jj worktree. /graphify [--include-nested] [symbol to explain]",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("graphify", "Local AST indexing…");
      try {
        const includeNested = /^--include-nested(?:\s|$)/.test(args.trim());
        const symbol = args.trim().replace(/^--include-nested(?:\s+|$)/, "");
        const result = await tasks.run(async (owned) => {
          await automatic.wait();
          owned.throwIfAborted();
          const root = await pickRoot(ctx, owned, includeNested);
          if (!root) throw new Error("No authorized root: indexing canceled.");
          const graphed = await dispatch(ctx.cwd, { op: "graph", root, action: symbol ? "explain" : "overview", symbol, includeNested }, owned) as Extract<GraphifyResult, { op: "graph" }>;
          if (!graphed.ok) throw new Error(graphed.message);
          return graphed;
        }, ctx.signal);
        ctx.ui.notify(result.text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("graphify", undefined);
      }
    },
  });
}
