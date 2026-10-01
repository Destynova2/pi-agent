// Desktop automation acts through host applications, not the project filesystem jail.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../../lib/rpc-process.ts";
import { McpConnection } from "../mcp/client.ts";

export default function dunstExtension(pi: ExtensionAPI) {
  let server: McpConnection | undefined;
  let generation = 0;
  let lifetime = new AbortController();
  const stop = async () => {
    generation++;
    lifetime.abort();
    lifetime = new AbortController();
    const previous = server;
    server = undefined;
    await previous?.rpc.shutdown();
  };
  pi.on("session_start", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_shutdown", stop);

  pi.registerTool({
    name: "dunst", label: "Dunst (host approval)",
    description: "Mac window automation through dunst-mcp. NOT confined by Codex: host applications can affect files and external services. Each operation, including server startup, requires a fresh human confirmation of the exact tool and arguments. help lists tools; help with args.name shows its schema. Server risk approval remains additional, never automatic.",
    promptSnippet: "Mac desktop automation, separate from the filesystem sandbox; explicit human approval per operation",
    promptGuidelines: ["Never send a message or submit a form without the user's explicit go for that exact action. Dunst is not a fallback for a sandbox denial."],
    parameters: Type.Object({ tool: Type.String(), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const epoch = generation;
      const owned = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      owned.throwIfAborted();
      const serialized = JSON.stringify({ tool: params.tool, args: params.args ?? {} });
      if (Buffer.byteLength(serialized) > 65536) throw new Error("Dunst request exceeds 64 KiB");
      // Confirm the immutable request, not a mutable params object retained across an await.
      const request = JSON.parse(serialized) as { tool: string; args: Record<string, unknown> };
      if (!(request.tool === "help" && server?.rpc.alive)) {
        if (!ctx.hasUI) throw new Error("Dunst host automation requires interactive human confirmation");
        const accepted = await ctx.ui.confirm("Dunst: outside the Codex sandbox", `This can control host applications and affect files or external services.\nAuthorize this exact operation once?\n${serialized}`, { signal: owned });
        owned.throwIfAborted();
        if (!accepted || epoch !== generation) throw new Error("Dunst operation not approved or session changed");
      }
      if (!server?.rpc.alive) {
        await server?.rpc.shutdown();
        owned.throwIfAborted();
        server = new McpConnection(new RpcProcess({ command: "dunst-mcp", args: ["serve"], cwd: ctx.cwd, env: { DUNST_MCP_ENABLE_APPROVE_TOOL: "1" } }));
      }
      const connection = server;
      try { return await connection.call(request.tool, request.args, owned); }
      catch (error) {
        if (server === connection) server = undefined;
        await connection.rpc.shutdown();
        throw error;
      }
    },
  });
  pi.registerCommand("dunst", {
    description: "/dunst [status|stop] — human-approved host automation",
    handler: async (arg, ctx) => {
      if (arg.trim() === "stop") { await stop(); ctx.ui.notify("dunst-mcp stopped", "info"); }
      else ctx.ui.notify(server?.rpc.alive ? `dunst-mcp running (${server.tools.length} tools); each operation requires confirmation` : "dunst-mcp stopped; startup requires confirmation", "info");
    },
  });
}
