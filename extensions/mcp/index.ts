import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
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
    if (data && Object.hasOwn(data, "mcpServers")) throw new Error("This confined MCP adapter uses servers, not native mcpServers. pi mcp commands configure native MCP, not this adapter. See docs/ORCHESTRATION.md.");
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
  const approvals = new McpApprovals(agentDir);
  let generation = 0;
  let lifetime = new AbortController();
  const stop = async () => {
    generation++; approvals.reset();
    lifetime.abort(); lifetime = new AbortController();
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
    description: "Use trusted, configured local MCP stdio servers inside Codex. Omit server to list configurations; use tool:'help' to discover tools. Declared read-only tools offer once/session/project consent; other calls require fresh exact approval. /mcp permissions revokes grants. Remote servers and host automation are unsupported; Dunst is separate.",
    promptGuidelines: ["Read-only annotations are unverified server claims, not a sandbox. Never use a remembered grant to send a message or submit a form without the user's explicit go for that exact action."],
    parameters: Type.Object({ server: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const owned = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      owned.throwIfAborted();
      const epoch = generation, cwd = realpathSync(ctx.cwd);
      const serialized = JSON.stringify({ server: params.server, tool: params.tool ?? "help", args: params.args ?? {} });
      if (Buffer.byteLength(serialized) > 65536) throw new Error("MCP request exceeds 64 KiB");
      const request = JSON.parse(serialized) as { server?: string; tool: string; args: Record<string, unknown> };
      const servers = readServers(agentDir, cwd);
      if (!request.server) return { content: [{ type: "text", text: JSON.stringify(Object.keys(servers)) }], details: undefined };
      const name = request.server;
      const configuration = () => {
        const current = readServers(agentDir, cwd);
        if (!Object.hasOwn(current, name)) throw new Error(`Unknown MCP server: ${name}`);
        const server = current[name];
        return { server, executable: serverIdentity(server.command, server.args, cwd, server.env) };
      };
      const { server, executable } = configuration();
      const config = fingerprint({ server, executable });
      const verify = () => {
        owned.throwIfAborted();
        if (epoch !== generation || cwd !== realpathSync(ctx.cwd) || config !== fingerprint(configuration())) throw new Error("MCP session or configuration changed; approval invalidated");
      };
      const key = `${cwd}\0${name}`;
      let entry = connections.get(key);
      if (entry && (entry.config !== config || !entry.connection.rpc.alive)) {
        connections.delete(key);
        await entry.connection.rpc.shutdown();
        entry = undefined;
      }
      verify();
      if (!entry) {
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = ["/usr/bin/env", ...Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`), executable.command, ...server.args].map(quote).join(" ");
        entry = { config, connection: new McpConnection(new RpcProcess({ command: launcher, args: [...(server.network ? [] : ["--offline"]), "-c", command], cwd })) };
        connections.set(key, entry);
      }
      const connection = entry.connection;
      try {
        // Private stdio definitions already authorize jailed startup and discovery, not arbitrary calls.
        await connection.start(owned);
        verify();
        let authorized = verify;
        if (request.tool !== "help") {
          const tool = connection.tools.find(tool => tool.name === request.tool);
          if (!tool) throw new Error(`Unknown MCP tool: ${request.tool}`);
          const manifest = fingerprint(tool);
          const remember = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
          authorized = await approvals.authorize(ctx, {
            resource: `mcp:${name}`, identity: fingerprint([config, manifest]), operation: remember ? request.tool : serialized,
            title: `MCP : ${name} / ${request.tool}`,
            detail: remember
              ? `Serveur : ${executable.command}\nOutil déclaré en lecture seule (non vérifié). Accord pour cet outil, tous ses paramètres, dans le sandbox existant. Aucun droit réseau ou fichier ajouté.\nUn accord permanent s'applique aussi aux sessions sans interface de ce projet. Révocation : /mcp permissions.`
              : `Serveur : ${executable.command}\nOpération sensible ou non déclarée en lecture seule.\nRequête exacte : ${serialized}`,
            remember, revalidate: () => { verify(); if (fingerprint(connection.tools.find(item => item.name === request.tool) ?? null) !== manifest) throw new Error("MCP tool definition changed"); },
          }, owned);
          authorized();
        }
        return await connection.call(request.tool, request.args, owned, authorized);
      } catch (error) {
        if (connections.get(key) === entry) connections.delete(key);
        await connection.rpc.shutdown();
        throw error;
      }
    },
  });
  pi.registerCommand("mcp", {
    description: "/mcp stops connections; /mcp permissions [server] revokes that server's project grants",
    handler: async (args, ctx) => {
      if (args.trim() === "permissions" || args.trim().startsWith("permissions ")) {
        if (!ctx.hasUI) throw new Error("Permission management requires interactive UI");
        const epoch = generation, cwd = realpathSync(ctx.cwd), owned = lifetime.signal;
        let name = args.trim().slice("permissions".length).trim();
        if (!name) {
          const names = Object.keys(readServers(agentDir, cwd));
          if (!names.length) { ctx.ui.notify("Aucun serveur configuré. Pour un ancien serveur : /mcp permissions <nom>", "info"); return; }
          name = await ctx.ui.select("MCP : serveur dont révoquer les autorisations", names, { signal: owned }) ?? "";
        }
        if (!name) return;
        const accepted = await ctx.ui.confirm("Révoquer les autorisations MCP ?", `${name}\nProjet : ${cwd}\nAccords de session et permanents. Les autres projets restent inchangés.`, { signal: owned });
        owned.throwIfAborted();
        if (accepted && epoch === generation && cwd === realpathSync(ctx.cwd)) {
          approvals.revoke(cwd, `mcp:${name}`); await stop(); ctx.ui.notify("Autorisations MCP révoquées pour ce serveur et ce projet", "info");
        }
      } else { await stop(); ctx.ui.notify("MCP connections stopped", "info"); }
    },
  });
}
