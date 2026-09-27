/**
 * notes - shared SQLite memory between agents (and subagents) on the same project.
 *
 * Project DB:  <git root>/.agent/notes.db  (excluded from git via .git/info/exclude)
 * Central DB:  ~/workspace/notes.db        (only if ~/workspace exists; mirror of every project)
 *
 * Every write goes to both except kind=ask (raw human prompts), which stays in the project DB.
 * Reads hit the project DB, or the central one with scope "all".
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SCHEMA = `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`;

const KINDS = ["ask", "plan", "decision", "done", "blocker", "lesson", "claim", "msg"] as const;
type Kind = (typeof KINDS)[number];

function open(file: string): DatabaseSync {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
	db.exec(SCHEMA);
	if (!db.prepare("SELECT 1 FROM pragma_table_info('notes') WHERE name = 'rev'").get()) db.exec("ALTER TABLE notes ADD COLUMN rev TEXT");
	return db;
}

function gitRoot(cwd: string): string {
	try {
		return execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return cwd;
	}
}

/** Restore point: jj operation id (`jj op restore <id>`) if the repo uses jj, else git HEAD (`git checkout <sha>`). */
function currentRev(root: string): string | undefined {
	const cmd = fs.existsSync(path.join(root, ".jj")) ? "jj op log --no-graph -n1 -T 'self.id().short(12)'" : "git rev-parse --short=12 HEAD";
	try {
		const out = execSync(cmd, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		return out ? `${cmd.startsWith("jj") ? "jj:" : "git:"}${out}` : undefined;
	} catch {
		return undefined;
	}
}

function excludeFromGit(root: string): void {
	const exclude = path.join(root, ".git", "info", "exclude");
	if (!fs.existsSync(path.dirname(exclude))) return;
	const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
	if (!current.split("\n").includes(".agent/")) fs.appendFileSync(exclude, `${current.endsWith("\n") || current === "" ? "" : "\n"}.agent/\n`);
}

export default function notes(pi: ExtensionAPI) {
	let project = "";
	let agent = "";
	let dbs: DatabaseSync[] = [];
	let central: DatabaseSync | undefined;
	let root = "";
	let lastSeenMsg = 0;

	pi.on("session_start", (_event, ctx) => {
		root = gitRoot(ctx.cwd);
		project = path.basename(root);
		agent = process.env.PI_AGENT_NAME ?? `pi-${process.pid}`;
		excludeFromGit(root);
		const local = open(path.join(root, ".agent", "notes.db"));
		const workspace = path.join(os.homedir(), "workspace");
		central = fs.existsSync(workspace) ? open(path.join(workspace, "notes.db")) : undefined;
		dbs = central ? [local, central] : [local];
	});

	function add(kind: Kind, body: string): void {
		const rev = currentRev(root) ?? null;
		// ask = raw human prompt: stays in the project DB, never mirrored outside the repo.
		for (const db of kind === "ask" ? [dbs[0]] : dbs) {
			db.prepare("INSERT INTO notes (project, agent, kind, body, rev) VALUES (?, ?, ?, ?, ?)").run(project, agent, kind, body, rev);
		}
	}

	// One-shot import of this project's past human prompts from ~/.pi/agent/sessions/**/*.jsonl (Claude Code / Codex history.jsonl idea).
	function importSessions(): number {
		const db = dbs[0];
		if ((db.prepare("SELECT count(*) AS n FROM notes WHERE agent LIKE 'session-%'").get() as { n: number }).n > 0) return -1;
		const files = fs.readdirSync(path.join(os.homedir(), ".pi", "agent", "sessions"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"));
		const insert = db.prepare("INSERT INTO notes (project, agent, kind, body, created_at) VALUES (?, ?, 'ask', ?, ?)");
		let n = 0;
		for (const f of files) {
			let proj = "";
			let sid = "";
			for (const line of fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "sessions", f), "utf8").split("\n")) {
				if (!line) continue;
				let e: { type?: string; id?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
				try { e = JSON.parse(line); } catch { continue; }
				if (e.type === "session") { proj = path.basename(e.cwd ?? ""); sid = `session-${(e.id ?? "").slice(0, 8)}`; continue; }
				if (proj !== project || e.type !== "message" || e.message?.role !== "user") continue;
				const c = e.message.content;
				const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { type?: string; text?: string }) => (p.type === "text" ? p.text : "")).join("") : "";
				const body = text.trim().split("\n")[0]?.slice(0, 200);
				if (!body) continue;
				insert.run(proj, sid, body, (e.timestamp ?? new Date().toISOString()).replace(/\.\d+Z$/, "Z"));
				n++;
			}
		}
		return n;
	}

	// /note <kind> <text>: write a note without spending a model turn (Claude Code's `#`). /note import: pull past prompts.
	pi.registerCommand("note", {
		description: "/note <plan|decision|done|blocker|lesson|claim|msg> <text> | /note import",
		handler: async (args, ctx) => {
			const [kind, ...rest] = args.trim().split(/\s+/);
			if (kind === "import") {
				const n = importSessions();
				return ctx.ui.notify(n < 0 ? "sessions already imported" : `imported ${n} prompts`, "info");
			}
			const body = rest.join(" ");
			if (!KINDS.includes(kind as Kind) || kind === "ask" || !body) return ctx.ui.notify("usage: /note <plan|decision|done|blocker|lesson|claim|msg> <text>", "warning");
			add(kind as Kind, body);
			ctx.ui.notify(`noted [${kind}] ${body}`, "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		const ask = event.prompt.trim().split("\n")[0]?.slice(0, 200);
		if (ask) add("ask", ask);
		// Inbox: messages from other agents of this project since last turn; "@name ..." only reaches name.
		const inbox = (dbs[0]
			.prepare("SELECT id, agent, body FROM notes WHERE project = ? AND kind = 'msg' AND id > ? AND agent <> ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') ORDER BY id")
			.all(project, lastSeenMsg, agent) as { id: number; agent: string; body: string }[])
			.filter((m) => !m.body.startsWith("@") || m.body.startsWith(`@${agent} `));
		lastSeenMsg = (dbs[0].prepare("SELECT coalesce(max(id), 0) AS id FROM notes").get() as { id: number }).id;
		event.systemPromptOptions.sections.shared_notes = [
			`Shared SQLite memory for agents working on project "${project}" (you are "${agent}").`,
			"- Start of a non-trivial task: call note_list to see what humans asked other agents (kind=ask, recorded automatically) and what those agents planned, claimed, decided or got blocked on.",
			"- Before touching a file or area another agent may also touch: note_add kind=claim with the paths. Do not edit a path another agent claimed.",
			"- Record decisions (kind=decision), completed work (kind=done), blockers (kind=blocker) and reusable lessons (kind=lesson) as one short line each. No status chatter.",
			"- Every note stores the repo revision at write time, shown as (jj:<op id>) or (git:<sha>) in note_list. To go back to the state of a note: `jj op restore <op id>` or `git checkout <sha>`. Write a kind=done note before risky changes so there is a point to return to.",
			"- Subagents load this same extension and share the same DB; write your plan (kind=plan) before delegating so they can read it.",
			"- To talk to another agent: note_add kind=msg, body starting with \"@<agent> \" for one agent or plain text for all. Messages arrive at their next turn as an <agent_inbox> message; answer with kind=msg too.",
		].join("\n");
		if (inbox.length === 0) return;
		return {
			message: {
				customType: "agent_inbox",
				content: `<agent_inbox>\n${inbox.map((m) => `${m.agent}: ${m.body}`).join("\n")}\n</agent_inbox>`,
				display: true,
			},
		};
	});

	// ctrl+r: search this project's past human prompts and put the pick back in the editor.
	// Frees the key from app.session.rename via ~/.pi/agent/keybindings.json.
	pi.registerShortcut(Key.ctrl("r"), {
		description: "Search prompt history",
		handler: async (ctx) => {
			const q = await ctx.ui.input("Search prompt history", "substring, empty = recent");
			if (q === undefined) return;
			const rows = dbs[0]
				.prepare("SELECT DISTINCT body FROM notes WHERE kind = 'ask' AND body LIKE ? ORDER BY id DESC LIMIT 40")
				.all(`%${q}%`) as { body: string }[];
			if (rows.length === 0) return ctx.ui.notify("no match", "info");
			const pick = await ctx.ui.select(`history: ${q || "recent"}`, rows.map((r) => r.body));
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
		async execute(_id, params: { kind: Kind; body: string }) {
			add(params.kind, params.body);
			return { content: [{ type: "text", text: `noted [${params.kind}] ${params.body}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "note_list",
		label: "note_list",
		description: "Read recent notes from the shared SQLite memory. scope=project (default) reads this project; scope=all reads every project from ~/workspace/notes.db.",
		parameters: Type.Object({
			kind: Type.Optional(Type.Union(KINDS.map((k) => Type.Literal(k)))),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("all")])),
			limit: Type.Optional(Type.Number({ default: 50 })),
		}),
		async execute(_id, params: { kind?: Kind; scope?: "project" | "all"; limit?: number }) {
			const all = params.scope === "all" && central;
			const db = all ? central : dbs[0];
			const where: string[] = [];
			const args: string[] = [];
			if (!all) { where.push("project = ?"); args.push(project); }
			if (params.kind) { where.push("kind = ?"); args.push(params.kind); }
			const sql = `SELECT created_at, project, agent, kind, body, rev FROM notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
			const rows = db.prepare(sql).all(...args, params.limit ?? 50) as { created_at: string; project: string; agent: string; kind: string; body: string; rev: string | null }[];
			const text = rows.length
				? rows.reverse().map((r) => `${r.created_at} ${all ? `${r.project} ` : ""}${r.agent} [${r.kind}]${r.rev ? ` (${r.rev})` : ""} ${r.body}`).join("\n")
				: "(no notes)";
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
