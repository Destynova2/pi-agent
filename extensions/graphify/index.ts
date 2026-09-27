import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectGraph } from "./core.ts";
import { chooseIndexRoot } from "./repositories.ts";
import { AutomaticIndex } from "./automatic.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

export default function (pi: ExtensionAPI) {
  let tasks = new SessionTasks();
  let automatic = new AutomaticIndex<Awaited<ReturnType<typeof projectGraph>> | undefined>();
  let selectedRoot: string | undefined;
  const approved = new Set<string>();
  const pickRoot = async (ctx: ExtensionContext, signal?: AbortSignal) => {
    const root = await chooseIndexRoot(selectedRoot ?? ctx.cwd, approved,
      ctx.hasUI ? (title, choices, owned) => ctx.ui.select(title, choices, { signal: owned }) : undefined, signal);
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
    ctx.ui.setStatus("graphify", "Indexation AST en arrière-plan…");
    automatic.start(
      async (signal) => {
        const root = await pickRoot(ctx, signal);
        return root ? projectGraph(root, "overview", "", signal) : undefined;
      },
      (result) => ctx.ui.setStatus("graphify", result ? `Graphify prêt : ${result.root}` : undefined),
      (error) => {
        ctx.ui.setStatus("graphify", undefined);
        ctx.ui.notify(`Indexation automatique indisponible : ${error instanceof Error ? error.message : String(error)}. /graphify permet de réessayer.`, "warning");
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
    label: "Carte du projet (Graphify)",
    description: "Indexation automatique en début de session Git/jj ; cet outil rafraîchit la carte via AST local, puis montre les symboles centraux ou les relations d'un symbole. Aucun appel LLM supplémentaire. Cache extérieur au dépôt, séparé par worktree. Respecte les ignores Graphify/Git.",
    promptSnippet: "Carte AST du projet Git/jj : symboles, appels et impacts.",
    promptGuidelines: ["Pour explorer un projet, project_graph peut cibler les lectures ; vérifier les sources avant de modifier. Ce graphe est incomplet et ne remplace pas les tests."],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("overview"), Type.Literal("explain"), Type.Literal("affected")]),
      symbol: Type.Optional(Type.String({ description: "Symbole requis pour explain/affected." })),
    }),
    execute: async (_id, params, signal, _update, ctx) => {
      const result = await tasks.run(async (owned) => {
        await automatic.wait();
        owned.throwIfAborted();
        const root = await pickRoot(ctx, owned);
        if (!root) throw new Error("Aucune racine autorisée : indexation annulée.");
        return projectGraph(root, params.action, params.symbol, owned);
      }, signal);
      return { content: [{ type: "text", text: result.text }], details: { root: result.root, graph: result.graph } };
    },
  });
  pi.registerCommand("graphify", {
    description: "Indexe la racine Git/jj (AST local). /graphify [symbole à expliquer]",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("graphify", "Indexation AST locale…");
      try {
        const symbol = args.trim();
        const result = await tasks.run(async (owned) => {
          await automatic.wait();
          owned.throwIfAborted();
          const root = await pickRoot(ctx, owned);
          if (!root) throw new Error("Aucune racine autorisée : indexation annulée.");
          return projectGraph(root, symbol ? "explain" : "overview", symbol, owned);
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
