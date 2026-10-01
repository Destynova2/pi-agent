/**
 * notes - shared SQLite memory between agents (and subagents) on the same project.
 *
 * Host wiring only (ExtensionAPI, UI, status): all SQLite, filesystem and git/jj access lives in
 * ./notes/worker.ts, dispatched through Codex. Missing or failed confinement is an error.
 */

import { runConfined } from "../lib/confined.ts";
import { SessionTasks } from "../lib/session-tasks.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { KINDS, type Kind, type NotesInput, type NotesResult } from "./notes/worker.ts";

async function dispatch(input: NotesInput, signal?: AbortSignal): Promise<NotesResult> {
	return await runConfined(input.cwd, "notes", input, signal) as NotesResult;
}

export default function notes(pi: ExtensionAPI) {
	let cwd = "";
	let agent = "";
	let lastSeenMsg = 0;
	let project = "";
	let tasks = new SessionTasks();
	const run = (input: NotesInput, signal?: AbortSignal) => tasks.run(owned => dispatch(input, owned), signal);
	const reset = async () => { await tasks.close(); tasks = new SessionTasks(); lastSeenMsg = 0; project = ""; };

	pi.on("session_start", async (_event, ctx) => {
		await reset();
		cwd = ctx.cwd;
		agent = process.env.PI_AGENT_NAME ?? `pi-${process.pid}`;
	});
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	pi.on("session_shutdown", () => tasks.close());

	async function add(kind: Kind, body: string, signal?: AbortSignal): Promise<void> {
		await run({ op: "add", cwd, agent, kind, body }, signal);
	}

	async function importSessions(): Promise<number> {
		const result = await run({ op: "importSessions", cwd, agent });
		return (result as { op: "importSessions"; imported: number }).imported;
	}

	async function readInbox(): Promise<string | undefined> {
		const result = await run({ op: "inbox", cwd, agent, afterId: lastSeenMsg }) as { op: "inbox"; text?: string; lastId: number; project: string };
		lastSeenMsg = result.lastId;
		project = result.project;
		return result.text;
	}

	// In-flight delivery: a subagent run checks its inbox after each tool call.
	pi.on("tool_result", async () => {
		const text = await readInbox();
		if (text) pi.sendMessage({ customType: "agent_inbox", content: text, display: true }, { deliverAs: "steer" });
	});

	pi.on("before_agent_start", async (event) => {
		const ask = event.prompt.trim().split("\n")[0]?.slice(0, 200);
		if (ask) await add("ask", ask);
		const inbox = await readInbox();
		// Only instruct the model to use tools it can actually call: a scout/reviewer run with
		// --tools excluding note_add (or note_list) must not be told to claim, write or list notes
		// it has no tool for.
		const active = pi.getActiveTools();
		const hasList = active.includes("note_list");
		const hasAdd = active.includes("note_add");
		if (hasList || hasAdd) {
			const lines = [`Shared SQLite memory for agents working on project "${project}" (you are "${agent}").`];
			if (hasList) lines.push("- Start of a non-trivial task: call note_list to see what humans asked other agents (kind=ask is a project-only first-line excerpt, not the full request) and what those agents planned, claimed, decided or got blocked on.");
			if (hasAdd) lines.push("- Before touching a file or area another agent may also touch: note_add kind=claim with the paths. Do not edit a path another agent claimed.");
			if (hasAdd) lines.push("- Record decisions (kind=decision), completed work (kind=done), blockers (kind=blocker) and reusable lessons (kind=lesson) as one short line each. No status chatter.");
			if (hasList) lines.push("- Every note stores the repo revision at write time, shown as (jj:<op id>) or (git:<sha>) in note_list for reference; it is not a rollback mechanism.");
			if (hasAdd) lines.push("- Subagents load this same extension and share the same DB; write your plan (kind=plan) before delegating so they can read it.");
			if (hasAdd) lines.push("- To talk to another agent: note_add kind=msg, body starting with \"@<agent> \" for one agent or plain text for all. Messages arrive at their next turn as an <agent_inbox> message; answer with kind=msg too.");
			event.systemPromptOptions.sections.shared_notes = lines.join("\n");
		}
		if (inbox) return { message: { customType: "agent_inbox", content: inbox, display: true } };
	});

	// /btw: write without a model turn (Claude Code's `#`). First word = kind -> note; "import" -> pull past prompts;
	// otherwise a message routed by @name, else by the agent whose active claim (24h) matches a path, else broadcast.
	pi.registerCommand("btw", {
		description: "/btw <plan|decision|done|blocker|lesson|claim> <text> | /btw import | /btw [@agent] <message>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("usage: /btw <kind> <text> | /btw import | /btw [@agent] <message>", "warning");
			const [first, ...rest] = text.split(/\s+/);
			if (first === "import") {
				const n = await importSessions();
				return ctx.ui.notify(n < 0 ? "sessions already imported" : `imported ${n} prompts`, "info");
			}
			if (KINDS.includes(first as Kind) && first !== "ask" && first !== "msg" && rest.length) {
				await add(first as Kind, rest.join(" "));
				return ctx.ui.notify(`noted [${first}] ${rest.join(" ")}`, "info");
			}
			let body = text;
			if (!text.startsWith("@")) {
				const claimsResult = await run({ op: "claims", cwd, agent }) as { op: "claims"; rows: { agent: string; body: string }[] };
				const words = text.split(/\s+/).filter((w) => w.includes("/") || w.includes("."));
				const hit = claimsResult.rows.find((c) => words.some((w) => c.body.includes(w) || w.includes(c.body.trim())));
				if (hit) body = `@${hit.agent} ${text}`;
			}
			await add("msg", body);
			ctx.ui.notify(body.startsWith("@") ? `sent to ${body.split(" ")[0]}` : "broadcast to project", "info");
		},
	});

	// ctrl+r: search this project's past human prompts and put the pick back in the editor.
	// Frees the key from app.session.rename via ~/.pi/agent/keybindings.json.
	pi.registerShortcut(Key.ctrl("r"), {
		description: "Search prompt history",
		handler: async (ctx) => {
			const q = await ctx.ui.input("Search prompt history", "substring, empty = recent");
			if (q === undefined) return;
			const result = await run({ op: "search", cwd, query: q, limit: 40 }, ctx.signal) as { op: "search"; rows: string[] };
			if (result.rows.length === 0) return ctx.ui.notify("no match", "info");
			const pick = await ctx.ui.select(`history: ${q || "recent"}`, result.rows);
			if (pick) ctx.ui.setEditorText(pick);
		},
	});

	pi.registerTool({
		name: "note_add",
		label: "note_add",
		description: "Write one short note into the shared project SQLite memory (also mirrored to ~/workspace/notes.db). kinds: plan, decision, done, blocker, lesson, claim, msg (ask is recorded automatically from human prompts). msg: message to other agents of this project, start body with \"@<agent> \" to target one.",
		parameters: Type.Object({
			kind: Type.Union(KINDS.filter((k) => k !== "ask").map((k) => Type.Literal(k))),
			body: Type.String({ description: "One line. For claim: the paths you are about to edit." }),
		}),
		async execute(_id, params: { kind: Kind; body: string }, signal) {
			await add(params.kind, params.body, signal);
			return { content: [{ type: "text", text: `noted [${params.kind}] ${params.body}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "note_list",
		label: "note_list",
		description: "Read recent notes from shared SQLite memory. scope=project (default) includes ask excerpts; scope=all reads the central mirror, which excludes asks. Ask records are first-line excerpts, not full requests: recover full requirements from session history or referenced task artifacts.",
		parameters: Type.Object({
			kind: Type.Optional(Type.Union(KINDS.map((k) => Type.Literal(k)))),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("all")])),
			limit: Type.Optional(Type.Number({ default: 50 })),
		}),
		async execute(_id, params: { kind?: Kind; scope?: "project" | "all"; limit?: number }, signal) {
			const result = await run({ op: "list", cwd, agent, kind: params.kind, scope: params.scope, limit: params.limit }, signal) as { op: "list"; text: string };
			return { content: [{ type: "text", text: result.text }], details: undefined };
		},
	});
}
