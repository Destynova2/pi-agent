// Verifies before_agent_start only tells the model to use note_list/note_add when those
// tools are actually active (pi.getActiveTools()), so a scout/reviewer run started with
// --tools excluding them isn't instructed to call a tool it doesn't have.
//
// Integration-only: extensions/notes.ts dispatches every op through lib/confined.ts's
// runConfined, which shells out to the real codex sandbox (scripts/codex-shell.mjs) with no
// in-process fallback. That needs a working, non-nested sandbox-exec and a codex binary
// (PI_CODEX_SANDBOX_BIN or ~/.local/bin/codex), so it belongs in `npm run test:integration`,
// not the default suite run from inside another sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../../notes.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Registers the extension against a fake ExtensionAPI, isolated in a temp HOME/cwd
 * (no real ~/workspace mirror, no real .git repo touched). */
async function setup(activeTools: string[]) {
	const home = await mkdtemp(join(tmpdir(), "pi-notes-tools-"));
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true }); // the jailed worker spawns with this as its cwd; it must exist beforehand.

	const oldHome = process.env.HOME;
	process.env.HOME = home; // os.homedir() reads this on POSIX; keeps ~/workspace mirror out of the picture.
	const events = new Map<string, Handler>();
	const tools = new Map<string, { execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown> }>();
	register({
		on: (event: string, handler: Handler) => { events.set(event, handler); return () => undefined; },
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (tool: { name: string; execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown> }) => tools.set(tool.name, tool),
		getActiveTools: () => activeTools,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI);
	await events.get("session_start")!({ type: "session_start", reason: "startup" }, { cwd });
	return {
		cwd, tools,
		async cleanup() {
			await events.get("session_shutdown")?.({}, { cwd });
			if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
			await rm(home, { recursive: true, force: true });
		},
		async beforeAgentStart(prompt: string) {
			const event = { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
			// Await the jailed worker before checking persisted state.
			const result = await events.get("before_agent_start")!(event, { cwd }) as { message?: unknown } | void;
			const db = new DatabaseSync(join(cwd, ".agent/notes.db"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT body FROM notes WHERE kind = 'ask' ORDER BY id DESC LIMIT 1").get()?.body, prompt);
			} finally { db.close(); }
			return { event, result };
		},
	};
}

test("canceled note calls never start a worker or create storage", async () => {
	const t = await setup(["note_add"]);
	try {
		await assert.rejects(t.tools.get("note_add")!.execute("test", { kind: "done", body: "not written" }, AbortSignal.abort()), /abort|cancel/i);
		assert.equal(existsSync(join(t.cwd, ".agent/notes.db")), false);
	} finally { await t.cleanup(); }
});

test("before_agent_start: full tools keeps every instruction (read + write)", async () => {
	const t = await setup(["note_list", "note_add"]);
	try {
		const { event } = await t.beforeAgentStart("do the thing");
		const section = event.systemPromptOptions.sections.shared_notes;
		assert.ok(section, "shared_notes section must be injected");
		assert.match(section, /call note_list/);
		assert.match(section, /note_add kind=claim/);
		assert.match(section, /Record decisions/);
		assert.match(section, /repo revision at write time/);
		assert.match(section, /write your plan \(kind=plan\)/);
		assert.match(section, /note_add kind=msg/);
		// Raw ask recording is preserved regardless of tool set.
		const dbFile = join(t.cwd, ".agent", "notes.db");
		assert.ok(existsSync(dbFile), "ask must still be recorded to the project db");
	} finally {
		await t.cleanup();
	}
});

test("before_agent_start: note_list only describes reading, never directs writes", async () => {
	const t = await setup(["note_list", "Read", "Bash"]);
	try {
		const { event } = await t.beforeAgentStart("scout this");
		const section = event.systemPromptOptions.sections.shared_notes;
		assert.ok(section, "shared_notes section must be injected");
		assert.match(section, /call note_list/);
		assert.match(section, /repo revision at write time/);
		assert.doesNotMatch(section, /note_add/);
		assert.doesNotMatch(section, /kind=claim/);
		assert.doesNotMatch(section, /kind=msg/);
		assert.doesNotMatch(section, /write your plan/);
	} finally {
		await t.cleanup();
	}
});

test("before_agent_start: note_add only directs writes, never mentions note_list", async () => {
	const t = await setup(["note_add", "Bash"]);
	try {
		const { event } = await t.beforeAgentStart("record this");
		const section = event.systemPromptOptions.sections.shared_notes;
		assert.ok(section, "shared_notes section must be injected");
		assert.match(section, /note_add kind=claim/);
		assert.match(section, /Record decisions/);
		assert.match(section, /note_add kind=msg/);
		assert.doesNotMatch(section, /call note_list/);
	} finally {
		await t.cleanup();
	}
});

test("before_agent_start: neither tool active injects no shared_notes section, but keeps ask/inbox behavior", async () => {
	const t = await setup(["Read", "Bash"]);
	try {
		const { event, result } = await t.beforeAgentStart("read only run");
		assert.equal(event.systemPromptOptions.sections.shared_notes, undefined);
		assert.equal(result, undefined); // no pending inbox message on a fresh project: no result returned either.
		const dbFile = join(t.cwd, ".agent", "notes.db");
		assert.ok(existsSync(dbFile), "ask must still be recorded even without note tools active");

	} finally {
		await t.cleanup();
	}
});
