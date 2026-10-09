import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { RpcProcess } from "../../lib/rpc-process.ts";
import { McpConnection } from "./client.ts";
import { prepareBrowserMcp, validateBrowserServer, type BrowserProfile } from "../../lib/browser-mcp.ts";

interface Server { command: string; args: string[]; env?: Record<string, string>; network?: boolean; browser?: BrowserProfile }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readServers(agentDir: string, cwd: string): Record<string, Server> {
  const rel = relative(realpathSync(cwd), realpathSync(agentDir));
  if (!rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) throw new Error("MCP configuration must be outside the writable workspace");
  let fd: number;
  try { fd = openSync(join(agentDir, "mcp.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid MCP configuration file");
    const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!record(data) || (!Object.hasOwn(data, "servers") && !Object.hasOwn(data, "mcpServers"))) throw new Error("Expected MCP servers or mcpServers object");
    const definitions = new Map<string, Server>(), names = new Set<string>();
    for (const format of ["servers", "mcpServers"]) {
      if (!Object.hasOwn(data, format)) continue;
      const entries = data[format], native = format === "mcpServers";
      if (!record(entries)) throw new Error(`Expected MCP ${format} object`);
      for (const [name, server] of Object.entries(entries)) {
        if (!name || names.has(name)) throw new Error("MCP server names must be nonempty and unique across servers and mcpServers");
        names.add(name);
        const allowed = native ? ["command", "args", "env", "network", "browser", "type", "enabled", "description", "exposure"] : ["command", "args", "env", "network", "browser"];
        if (!record(server) || typeof server.command !== "string" || !server.command ||
          (!native && !Array.isArray(server.args)) ||
          (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(arg => typeof arg === "string"))) ||
          Object.keys(server).some(key => !allowed.includes(key)) ||
          (server.network !== undefined && typeof server.network !== "boolean") ||
          (server.type !== undefined && server.type !== "stdio") ||
          (server.enabled !== undefined && typeof server.enabled !== "boolean") ||
          (server.description !== undefined && typeof server.description !== "string") ||
          (server.exposure !== undefined && server.exposure !== "codemode") ||
          (server.env !== undefined && (!record(server.env) || Object.entries(server.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")))) {
          throw new Error("MCP supports configured local stdio servers only (command, args, env, network; native type, enabled, description and codemode exposure). Remote URLs, cwd, timeout, toolExposure and other exposure modes are unsupported.");
        }
        if (server.enabled === false) continue;
        const definition: Server = {
          command: server.command, args: (server.args ?? []) as string[],
          ...(server.env === undefined ? {} : { env: server.env as Record<string, string> }),
          ...(native ? { network: server.network ?? true } : server.network === undefined ? {} : { network: server.network }),
          ...(server.browser === undefined ? {} : { browser: server.browser as BrowserProfile }),
        };
        if (Object.hasOwn(server, "browser")) validateBrowserServer(definition);
        definitions.set(name, definition);
      }
    }
    return Object.fromEntries(definitions);
  } finally { closeSync(fd); }
}

export default function (pi: ExtensionAPI, prepareBrowser = prepareBrowserMcp) {
  const agentDir = getAgentDir();
  const launcher = fileURLToPath(new URL("../../scripts/codex-shell.mjs", import.meta.url));
  const connections = new Map<string, { cwd: string; name: string; definition: string; config: string; connection: McpConnection; capability?: () => void }>();
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
    description: "Use trusted local MCP stdio servers inside Codex, or Playwright's explicitly configured browser container after launch approval. Global pi mcp add/remove changes are read on each call. Omit server to list configurations; use tool:'help' to discover tools. Declared read-only tools and tools in the isolated Playwright container offer once/session/project consent per tool; other calls require fresh exact approval. Remembered browser control requires the interactive parent. /mcp permissions revokes grants and stops connections. Browser containers have their own network and no host files; host.containers.internal reaches local host services. Remote MCP and general host execution are unsupported.",
    promptGuidelines: ["Read-only annotations are unverified server claims, not a sandbox. Never use a remembered grant to send a message or submit a form without the user's explicit go for that exact action.", "Playwright 0.0.83 navigation returns a snapshot file link. Call browser_snapshot without a filename to read the DOM inline and obtain element refs; container files are not host files. Use configured browser.localhostPorts to retain localhost URLs for local apps, or host.containers.internal for other host services."],
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
      // Reconcile definitions without interrupting unchanged server connections.
      for (const [key, entry] of connections) {
        if (entry.cwd === cwd && (!Object.hasOwn(servers, entry.name) || entry.definition !== fingerprint(servers[entry.name]))) {
          connections.delete(key);
          await entry.connection.rpc.shutdown();
        }
      }
      owned.throwIfAborted();
      if (!request.server) return { content: [{ type: "text", text: JSON.stringify(Object.keys(servers)) }], details: undefined };
      const name = request.server;
      const configuration = () => {
        const current = readServers(agentDir, cwd);
        if (!Object.hasOwn(current, name)) throw new Error(`Unknown MCP server: ${name}`);
        const server = current[name];
        return { server, executable: serverIdentity(server.command, server.args, cwd, server.env) };
      };
      const { server, executable } = configuration();
      if (server.browser && process.env.PI_SUBAGENT_CHILD) throw new Error("Browser MCP requires the parent session; browser launch is not delegated");
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
        let connection: McpConnection, capability: (() => void) | undefined;
        if (server.browser) {
          const browser = await prepareBrowser(server, cwd, agentDir, owned);
          capability = await approvals.authorize(ctx, {
            resource: `mcp-browser:${name}`, identity: fingerprint([config, browser.identity]), operation: "launch", auditOperation: "browser_launch", toolCallId: _id,
            title: `Autoriser le navigateur MCP : ${name} ?`, detail: browser.detail, remember: true,
            revalidate: () => { verify(); browser.verify(); },
          }, owned);
          connection = new McpConnection(await browser.start(capability));
        } else {
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
          const environment = ["/usr/bin/env", ...Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`)].map(quote).join(" ");
          // Expand only the launcher's private TMPDIR, inside the jail. Configuration stays literal.
          const command = `${environment} 'npm_config_ignore_scripts=true' "npm_config_cache=$TMPDIR/pi-mcp-npm" ${[executable.command, ...server.args].map(quote).join(" ")}`;
          connection = new McpConnection(new RpcProcess({ command: launcher, args: [...(server.network ? [] : ["--offline"]), "-c", command], cwd }));
        }
        entry = { cwd, name, definition: fingerprint(server), config, connection, capability };
        connections.set(key, entry);
      }
      const connection = entry.connection;
      const verifyCall = () => { verify(); entry?.capability?.(); };
      try {
        // Private stdio definitions already authorize jailed startup and discovery, not arbitrary calls.
        await connection.start(owned);
        verifyCall();
        let authorized = verifyCall;
        if (request.tool !== "help") {
          const tool = connection.tools.find(tool => tool.name === request.tool);
          if (!tool) throw new Error(`Unknown MCP tool: ${request.tool}`);
          const manifest = fingerprint(tool);
          const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
          const browserControl = !!server.browser && !readOnly;
          const remember = readOnly || browserControl;
          authorized = await approvals.authorize(ctx, {
            auditOperation: request.tool, toolCallId: _id,
            resource: `mcp:${name}`, identity: fingerprint([config, manifest]), operation: remember ? request.tool : serialized,
            title: `MCP : ${name} / ${request.tool}`,
            detail: readOnly
              ? `Serveur : ${server.browser ? "Playwright en conteneur Podman" : executable.command}\nOutil déclaré en lecture seule (non vérifié). Accord pour cet outil, tous ses paramètres, dans le sandbox existant. Aucun droit réseau ou fichier ajouté.\nUn accord permanent s'applique aussi aux sessions sans interface de ce projet. Révocation : /mcp permissions.`
              : browserControl
                ? `Playwright en conteneur Podman isolé. Cette fois : la requête exacte ci-dessous. Session/projet : cet outil avec tous ses paramètres, y compris interactions et JavaScript pouvant modifier les sites visités ou envoyer des données. Accès au réseau du conteneur et aux services locaux configurés ; aucun dossier, profil ou secret hôte monté. Accord lié au projet, à la configuration, à l'image et à la définition de l'outil. Révocation : /mcp permissions.\nRequête exacte : ${serialized}`
                : `Serveur : ${executable.command}\nOpération sensible ou non déclarée en lecture seule.\nRequête exacte : ${serialized}`,
            remember, interactiveOnly: browserControl,
            revalidate: () => { verifyCall(); if (fingerprint(connection.tools.find(item => item.name === request.tool) ?? null) !== manifest) throw new Error("MCP tool definition changed"); },
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
          approvals.revoke(cwd, `mcp:${name}`); approvals.revoke(cwd, `mcp-browser:${name}`); await stop(); ctx.ui.notify("Autorisations MCP révoquées pour ce serveur et ce projet", "info");
        }
      } else { await stop(); ctx.ui.notify("MCP connections stopped", "info"); }
    },
  });
}
