import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../../lib/rpc-process.ts";
import { McpConnection } from "./client.ts";

interface Server { command: string; args: string[]; env?: Record<string, string>; network?: boolean }

export function readServers(agentDir: string, cwd: string): Record<string, Server> {
  const rel = relative(realpathSync(cwd), realpathSync(agentDir));
  if (!rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) throw new Error("MCP configuration must be outside the writable workspace");
  let fd: number;
  try { fd = openSync(join(agentDir, "mcp.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid MCP configuration file");
    const data = JSON.parse(readFileSync(fd, "utf8"));
    if (!data || typeof data.servers !== "object" || !data.servers || Array.isArray(data.servers)) throw new Error("Expected MCP servers object");
    for (const server of Object.values(data.servers) as Server[]) {
      if (!server || typeof server !== "object" || typeof server.command !== "string" || !server.command ||
        !Array.isArray(server.args) || !server.args.every(arg => typeof arg === "string") ||
        Object.keys(server).some(key => !["command", "args", "env", "network"].includes(key)) ||
        (server.network !== undefined && typeof server.network !== "boolean") ||
        (server.env !== undefined && (!server.env || typeof server.env !== "object" || Array.isArray(server.env) || Object.entries(server.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")))) {
        throw new Error("MCP supports configured local stdio servers only (command, args, env, network)");
      }
    }
    return data.servers;
  } finally { closeSync(fd); }
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const launcher = fileURLToPath(new URL("../../scripts/codex-shell.mjs", import.meta.url));
  const connections = new Map<string, { config: string; connection: McpConnection }>();
  let generation = 0;
  const stop = async () => {
    generation++;
    const current = [...connections.values()];
    connections.clear();
    const settled = await Promise.allSettled(current.map(({ connection }) => connection.rpc.shutdown()));
    const failure = settled.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  pi.on("session_start", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_shutdown", stop);
  pi.registerTool({
    name: "mcp", label: "MCP (confined)",
    description: "Use trusted, configured local MCP stdio servers inside Codex. Omit server to list configurations; use tool:'help' to discover a server's tools. Remote servers and host automation are not supported here; Dunst is a separate human-approved host tool.",
    parameters: Type.Object({ server: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const epoch = generation;
      const servers = readServers(agentDir, ctx.cwd);
      if (!params.server) return { content: [{ type: "text", text: JSON.stringify(Object.keys(servers)) }], details: undefined };
      if (!Object.hasOwn(servers, params.server)) throw new Error(`Unknown MCP server: ${params.server}`);
      const server = servers[params.server];
      const config = JSON.stringify(server);
      const key = `${realpathSync(ctx.cwd)}\0${params.server}`;
      let entry = connections.get(key);
      if (entry && (entry.config !== config || !entry.connection.rpc.alive)) {
        connections.delete(key);
        await entry.connection.rpc.shutdown();
        entry = undefined;
      }
      if (epoch !== generation) throw new Error("MCP session changed");
      if (!entry) {
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = ["/usr/bin/env", ...Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`), server.command, ...server.args].map(quote).join(" ");
        entry = { config, connection: new McpConnection(new RpcProcess({ command: launcher, args: [...(server.network ? [] : ["--offline"]), "-c", command], cwd: ctx.cwd })) };
        connections.set(key, entry);
      }
      try { return await entry.connection.call(params.tool ?? "help", params.args ?? {}, signal); }
      catch (error) {
        connections.delete(key);
        await entry.connection.rpc.shutdown();
        throw error;
      }
    },
  });
  pi.registerCommand("mcp", { description: "Stop configured MCP connections", handler: async (_args, ctx) => { await stop(); ctx.ui.notify("MCP connections stopped", "info"); } });
}
