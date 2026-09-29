/**
 * dunst: bridge the dunst-mcp stdio server (macOS background UI automation)
 * into pi as ONE tool, so its 73 tool schemas do not bloat the context.
 *
 * Tool: dunst { tool: string, args?: object }
 *   - tool: "help"                → list the server's tools (name + summary)
 *   - tool: "help", args: {name}  → full description + input schema of one tool
 *   - any other name              → tools/call on the server
 * Command: /dunst [status|stop]
 *
 * The server is spawned lazily on first use (`dunst-mcp serve`, Notes fixture),
 * then re-targeted at runtime with the server's own `attach` tool.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;
interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Json;
}
interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

const MAX_TEXT = 60_000;

class DunstServer {
	private proc?: ChildProcess;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private ready?: Promise<void>;
	tools: McpTool[] = [];

	get alive(): boolean {
		return !!this.proc && this.proc.exitCode === null;
	}

	start(): Promise<void> {
		if (this.ready && this.alive) return this.ready;
		this.ready = this.spawn();
		return this.ready;
	}

	private async spawn(): Promise<void> {
		const proc = spawn("dunst-mcp", ["serve"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DUNST_MCP_ENABLE_APPROVE_TOOL: "1" } });
		this.proc = proc;
		proc.on("exit", () => {
			for (const p of this.pending.values()) p.reject(new Error("dunst-mcp exited"));
			this.pending.clear();
		});
		proc.stderr?.on("data", () => {}); // keep the pipe drained; server logs are chatty
		createInterface({ input: proc.stdout! }).on("line", (line) => {
			if (!line.trim()) return;
			let msg: Json;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			const id = msg.id as number | undefined;
			const p = id !== undefined ? this.pending.get(id) : undefined;
			if (!p) return;
			this.pending.delete(id!);
			if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
			else p.resolve(msg.result);
		});
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "pi", version: "0" },
		});
		this.notify("notifications/initialized", {});
		const list = (await this.request("tools/list", {})) as { tools: McpTool[] };
		this.tools = list.tools;
	}

	private send(msg: Json): void {
		if (!this.alive) throw new Error("dunst-mcp is not running");
		this.proc!.stdin!.write(`${JSON.stringify(msg)}\n`);
	}

	private notify(method: string, params: Json): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	request(method: string, params: Json): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (e) {
				this.pending.delete(id);
				reject(e as Error);
			}
		});
	}

	async call(name: string, args: Json): Promise<McpContent[]> {
		await this.start();
		const res = (await this.request("tools/call", { name, arguments: args })) as {
			content?: McpContent[];
			isError?: boolean;
		};
		if (res.isError) throw new Error(res.content?.map((c) => c.text ?? "").join("\n") || `${name} failed`);
		return res.content ?? [];
	}

	stop(): void {
		this.proc?.kill();
		this.proc = undefined;
		this.ready = undefined;
	}
}

function summary(t: McpTool): string {
	const first = (t.description ?? "").split(/\.\s|\n/)[0];
	return `${t.name}: ${first.slice(0, 110)}`;
}

export default function dunstExtension(pi: ExtensionAPI) {
	const server = new DunstServer();

	pi.registerTool({
		name: "dunst",
		label: "Dunst",
		description:
			"Drive a macOS window in the background through dunst-mcp (AX-first perception, risk-gated actions, audit). " +
			"Call {tool:'help'} first to list the server tools, {tool:'help', args:{name}} for one tool's schema, " +
			"then {tool:<name>, args:{...}}. Typical flow: list_windows → attach {window_id} → page_state / find_element / " +
			"screenshot → click_element / type_into / scroll. High-risk actions return pending_approval and need the human.",
		promptSnippet: "Background macOS UI automation via dunst-mcp (tool:'help' to list server tools)",
		promptGuidelines: [
			"Use dunst only for macOS window perception/automation; never send a message or submit a form on the user's behalf without their explicit go for that exact action.",
		],
		parameters: Type.Object({
			tool: Type.String({ description: "Server tool name, or 'help'" }),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the server tool" })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const args = (params.args ?? {}) as Json;
			if (params.tool === "help") {
				await server.start();
				const name = args.name as string | undefined;
				if (name) {
					const t = server.tools.find((x) => x.name === name);
					if (!t) throw new Error(`unknown dunst tool: ${name}`);
					const text = `${t.name}\n\n${t.description ?? ""}\n\nschema: ${JSON.stringify(t.inputSchema ?? {}, null, 1)}`;
					return { content: [{ type: "text", text }], details: undefined };
				}
				const text = `${server.tools.length} tools:\n${server.tools.map(summary).join("\n")}`;
				return { content: [{ type: "text", text }], details: undefined };
			}
			const out = await server.call(params.tool, args);
			const content = out.map((c) => {
				if (c.type === "image" && c.data) return { type: "image" as const, data: c.data, mimeType: c.mimeType ?? "image/png" };
				const text = c.text ?? JSON.stringify(c);
				return {
					type: "text" as const,
					text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} chars]` : text,
				};
			});
			return { content, details: undefined };
		},
	});

	pi.registerCommand("dunst", {
		description: "/dunst [status|stop] — dunst-mcp bridge",
		handler: async (arg, ctx) => {
			if (arg.trim() === "stop") {
				server.stop();
				ctx.ui.notify("dunst-mcp stopped", "info");
				return;
			}
			ctx.ui.notify(server.alive ? `dunst-mcp running, ${server.tools.length} tools` : "dunst-mcp not running (starts on first tool call)", "info");
		},
	});

	pi.on("session_shutdown", () => server.stop());
}
