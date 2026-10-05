// Desktop automation acts through host applications, not the project filesystem jail.
import { realpathSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { RpcProcess } from "../../lib/rpc-process.ts";
import { McpConnection } from "../mcp/client.ts";

// Only perception and the daemon's own target selection, never app input or risk approval.
export const DUNST_OBSERVATION = new Set([
  "help", "version", "platform_capabilities", "refresh", "get_scene_graph", "page_state", "text_snapshot",
  "list_browser_tabs", "list_displays", "window_view", "desktop_view", "target_visibility", "get_affordances",
  "get_hit_targets", "find_element", "read_text", "read_text_detailed", "find_ocr_text", "list_windows",
  "list_apps", "list_launchable_apps", "app_info", "attach", "screenshot", "verify_state", "diff_since",
]);

export default function dunstExtension(pi: ExtensionAPI) {
  const approvals = new McpApprovals(getAgentDir());
  let server: McpConnection | undefined;
  let configuration: string | undefined;
  let generation = 0;
  let lifetime = new AbortController();
  const stop = async () => {
    generation++; approvals.reset();
    lifetime.abort(); lifetime = new AbortController();
    const previous = server;
    server = undefined; configuration = undefined;
    await previous?.rpc.shutdown();
  };
  pi.on("session_start", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_shutdown", stop);

  pi.registerTool({
    name: "dunst", label: "Dunst (host approval)",
    description: "Mac window automation through dunst-mcp, outside Codex. Observation can be approved once, for this session, or always for this project. Clicks, typing, launches and unknown operations require fresh exact approval. help lists tools; help with args.name shows its schema. Server risk approval remains additional, never automatic. /dunst permissions revokes consent.",
    promptSnippet: "Mac desktop automation; remembered observation consent, fresh approval for actions",
    promptGuidelines: ["Never send a message or submit a form without the user's explicit go for that exact action. Dunst is not a fallback for a sandbox denial. Never call an approval tool to approve your own pending action."],
    parameters: Type.Object({ tool: Type.String(), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const epoch = generation, cwd = realpathSync(ctx.cwd);
      const owned = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      owned.throwIfAborted();
      if (!ctx.hasUI) throw new Error("Dunst host automation requires interactive human confirmation");
      const serialized = JSON.stringify({ tool: params.tool, args: params.args ?? {} });
      if (Buffer.byteLength(serialized) > 65536) throw new Error("Dunst request exceeds 64 KiB");
      const request = JSON.parse(serialized) as { tool: string; args: Record<string, unknown> };
      const env = { DUNST_MCP_ENABLE_APPROVE_TOOL: "1" };
      const executable = serverIdentity("dunst-mcp", ["serve"], cwd, env);
      const identity = fingerprint([executable, env, [...DUNST_OBSERVATION]]);
      const verify = () => {
        owned.throwIfAborted();
        if (epoch !== generation || cwd !== realpathSync(ctx.cwd) || identity !== fingerprint([serverIdentity("dunst-mcp", ["serve"], cwd, env), env, [...DUNST_OBSERVATION]])) throw new Error("Dunst session or executable changed; approval invalidated");
      };
      if (server && configuration !== identity) { const previous = server; server = undefined; await previous.rpc.shutdown(); }
      let authorized = verify;
      if (!(request.tool === "help" && server?.rpc.alive)) {
        const observe = DUNST_OBSERVATION.has(request.tool);
        authorized = await approvals.authorize(ctx, {
          resource: "dunst", identity, operation: observe ? "observation" : serialized,
          title: "Dunst : accès aux applications du Mac, hors sandbox",
          detail: observe
            ? `Observer les fenêtres, le texte, l'état et les captures ; choisir la fenêtre ciblée. Toutes les applications, même privées ou hors projet.\nServeur : ${JSON.stringify(executable.command)} (démarrage compris).\nAucun clic, saisie, lancement d'application ou accord de risque mémorisé.\nRévocation : /dunst permissions.`
            : `Exécutable : ${JSON.stringify(executable.command)}\nCette action peut modifier des fichiers ou envoyer des données.\nRequête exacte : ${serialized}`,
          remember: observe, interactiveOnly: true, revalidate: verify,
        }, owned);
      }
      authorized();
      if (!server?.rpc.alive) {
        await server?.rpc.shutdown(); authorized();
        server = new McpConnection(new RpcProcess({ command: executable.command, args: ["serve"], cwd, env }));
        configuration = identity;
      }
      const connection = server;
      try { return await connection.call(request.tool, request.args, owned, authorized); }
      catch (error) {
        if (server === connection) server = undefined;
        await connection.rpc.shutdown(); throw error;
      }
    },
  });
  pi.registerCommand("dunst", {
    description: "/dunst [status|stop|permissions] — observation consent and exact host actions",
    handler: async (arg, ctx) => {
      if (arg.trim() === "permissions") {
        const epoch = generation, cwd = realpathSync(ctx.cwd);
        if (!ctx.hasUI) throw new Error("Permission management requires interactive UI");
        const choice = await ctx.ui.select(`Dunst — ${cwd}\nRévoquer les accords de session et permanents de ce projet ?`, ["Annuler", "Révoquer"], { signal: lifetime.signal });
        if (choice === "Révoquer" && epoch === generation && cwd === realpathSync(ctx.cwd)) {
          approvals.revoke(cwd, "dunst"); await stop(); ctx.ui.notify("Autorisations Dunst révoquées pour ce projet", "info");
        }
      } else if (arg.trim() === "stop") { await stop(); ctx.ui.notify("dunst-mcp stopped", "info"); }
      else ctx.ui.notify(`${server?.rpc.alive ? "dunst-mcp running" : "dunst-mcp stopped"}; observation consent can be remembered. Actions still require exact approval. /dunst permissions to revoke.`, "info");
    },
  });
}
