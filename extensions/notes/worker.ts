/**
 * notes worker -- the only module in this extension allowed to touch SQLite, the filesystem
 * outside the extension's own state, or shell out to git/jj. The host extension routes every
 * operation through lib/confined.ts. There is no in-process execution fallback.
 *
 * Contract: every operation carries its own `cwd` (the session's canonical, jailed root) so root
 * and revision detection happen here, not on the host. No operation accepts an absolute path
 * outside `cwd`'s tree other than the central mirror, which is a fixed, well-known location
 * (`~/workspace/notes.db`) the parent grants explicitly.
 *
 * Project DB:  <git root>/.agent/notes.db  (excluded from git via .git/info/exclude)
 * Central DB:  ~/workspace/notes.db        (only if ~/workspace exists; mirror of every project)
 * Every write goes to both except kind=ask (raw human prompts), which stays in the project DB.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SCHEMA = `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`;

export const KINDS = ["ask", "plan", "decision", "done", "blocker", "lesson", "claim", "msg"] as const;
export type Kind = (typeof KINDS)[number];

export type NotesInput =
	| { op: "add"; cwd: string; agent: string; kind: Kind; body: string }
	| { op: "list"; cwd: string; agent: string; kind?: Kind; scope?: "project" | "all"; limit?: number }
	| { op: "inbox"; cwd: string; agent: string; afterId: number }
	| { op: "importSessions"; cwd: string; agent: string }
	| { op: "search"; cwd: string; query: string; limit?: number }
	| { op: "claims"; cwd: string; agent: string };

export type NotesResult =
	| { op: "add" }
	| { op: "list"; text: string }
	| { op: "inbox"; text?: string; lastId: number; project: string }
	| { op: "importSessions"; imported: number }
	| { op: "search"; rows: string[] }
	| { op: "claims"; rows: { agent: string; body: string }[] };

type Row = { created_at: string; project: string; agent: string; kind: string; body: string; rev: string | null };

const handles = new Map<string, DatabaseSync>();

function open(file: string, fixedFiles = false): DatabaseSync {
	const cached = handles.get(file);
	if (cached) return cached;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	// A central database is granted as exact Linux bind-mounted files. Persistent
	// rollback journals avoid unlink/rename operations on those mount points.
	db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=${fixedFiles ? "PERSIST" : "WAL"};`);
	db.exec(SCHEMA);
	if (!db.prepare("SELECT 1 FROM pragma_table_info('notes') WHERE name = 'rev'").get()) db.exec("ALTER TABLE notes ADD COLUMN rev TEXT");
	handles.set(file, db);
	return db;
}

function gitRoot(cwd: string): string {
	try {
		return execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return cwd;
	}
}

/** Revision recorded on each note for provenance only, not a restore point. */
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

function context(cwd: string) {
	const root = gitRoot(cwd);
	excludeFromGit(root);
	const project = path.basename(root);
	const local = open(path.join(root, ".agent", "notes.db"));
	const workspace = path.join(os.homedir(), "workspace");
	const central = fs.existsSync(workspace) ? open(path.join(workspace, "notes.db"), process.platform === "linux") : undefined;
	return { root, project, local, central };
}

/** Jailed entry point: the parent's launcher (lib/confined.ts) will invoke this inside a process
 * whose cwd and filesystem access are restricted to the session root plus the local/central db
 * files. Every field needed (cwd, agent, kind, body...) travels in `input`; nothing is read from
 * ambient host state. */
export async function executeNotes(input: NotesInput): Promise<NotesResult> {
	if (!input || !["add", "list", "inbox", "importSessions", "search", "claims"].includes(input.op)) throw new Error("Unknown notes operation");
	if (typeof input.cwd !== "string") throw new Error("Notes cwd is required");
	if (input.op !== "search" && (typeof input.agent !== "string" || !input.agent || input.agent.length > 128)) throw new Error("Invalid notes agent");
	if (input.op === "list" && input.scope !== undefined && !["project", "all"].includes(input.scope)) throw new Error("Invalid notes scope");
	if ("limit" in input && input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)) throw new Error("Notes limit must be 1..1000");
	if ("kind" in input && input.kind !== undefined && !KINDS.includes(input.kind)) throw new Error("Invalid note kind");
	if (input.op === "add" && (!KINDS.includes(input.kind) || typeof input.body !== "string" || input.body.length > 16384)) throw new Error("Invalid note kind or body");
	if (input.op === "search" && typeof input.query !== "string") throw new Error("Invalid notes query");
	if (input.op === "inbox" && (!Number.isSafeInteger(input.afterId) || input.afterId < 0)) throw new Error("Invalid inbox cursor");
	const { root, project, local, central } = context(input.cwd);
	switch (input.op) {
		case "add": {
			const rev = currentRev(root) ?? null;
			const dbs = input.kind === "ask" ? [local] : central ? [local, central] : [local];
			for (const db of dbs) db.prepare("INSERT INTO notes (project, agent, kind, body, rev) VALUES (?, ?, ?, ?, ?)").run(project, input.agent, input.kind, input.body, rev);
			return { op: "add" };
		}
		case "list": {
			const all = input.scope === "all" && central;
			const db = all ? central! : local;
			const where: string[] = [];
			const args: string[] = [];
			if (!all) { where.push("project = ?"); args.push(project); }
			if (input.kind) { where.push("kind = ?"); args.push(input.kind); }
			const sql = `SELECT created_at, project, agent, kind, body, rev FROM notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
			const rows = db.prepare(sql).all(...args, input.limit ?? 50) as Row[];
			const text = rows.length
				? rows.reverse().map((r) => `${r.created_at} ${all ? `${r.project} ` : ""}${r.agent} [${r.kind}]${r.rev ? ` (${r.rev})` : ""} ${r.body}`).join("\n")
				: "(no notes)";
			return { op: "list", text };
		}
		case "inbox": {
			const lastId = (local.prepare("SELECT coalesce(max(id), 0) AS id FROM notes").get() as { id: number }).id;
			const rows = (local
				.prepare("SELECT id, agent, body FROM notes WHERE project = ? AND kind = 'msg' AND id > ? AND id <= ? AND agent <> ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') ORDER BY id")
				.all(project, input.afterId, lastId, input.agent) as { id: number; agent: string; body: string }[])
				.filter((m) => !m.body.startsWith("@") || m.body.startsWith(`@${input.agent} `));
			return { op: "inbox", text: rows.length ? `<agent_inbox>\n${rows.map((m) => `${m.agent}: ${m.body}`).join("\n")}\n</agent_inbox>` : undefined, lastId, project };
		}
		case "importSessions": {
			if ((local.prepare("SELECT count(*) AS n FROM notes WHERE agent LIKE 'session-%'").get() as { n: number }).n > 0) return { op: "importSessions", imported: -1 };
			const sessionsDir = path.join(getAgentDir(), "sessions");
			const files = fs.readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl"));
			const insert = local.prepare("INSERT INTO notes (project, agent, kind, body, created_at) VALUES (?, ?, 'ask', ?, ?)");
			let n = 0;
			for (const f of files) {
				let proj = "";
				let sid = "";
				for (const line of fs.readFileSync(path.join(sessionsDir, f), "utf8").split("\n")) {
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
			return { op: "importSessions", imported: n };
		}
		case "search": {
			const rows = (local
				.prepare("SELECT DISTINCT body FROM notes WHERE kind = 'ask' AND body LIKE ? ORDER BY id DESC LIMIT ?")
				.all(`%${input.query}%`, input.limit ?? 40) as { body: string }[])
				.map((r) => r.body);
			return { op: "search", rows };
		}
		case "claims": {
			const rows = local
				.prepare("SELECT agent, body FROM notes WHERE project = ? AND kind = 'claim' AND agent <> ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') ORDER BY id DESC")
				.all(project, input.agent) as { agent: string; body: string }[];
			return { op: "claims", rows };
		}
	}
}
