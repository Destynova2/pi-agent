// Verifies before_agent_start only tells the model to use note_list/note_add when those
// tools are actually active (pi.getActiveTools()), so a scout/reviewer run started with
// --tools excluding them isn't instructed to call a tool it doesn't have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
	const oldHome = process.env.HOME;
	process.env.HOME = home; // os.homedir() reads this on POSIX; keeps ~/workspace mirror out of the picture.
	const events = new Map<string, Handler>();
	register({
		on: (event: string, handler: Handler) => { events.set(event, handler); return () => undefined; },
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		getActiveTools: () => activeTools,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI);
	await events.get("session_start")!({ type: "session_start", reason: "startup" }, { cwd });
	return {
		cwd,
		async cleanup() {
			if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
			await rm(home, { recursive: true, force: true });
		},
		beforeAgentStart(prompt: string) {
			const event = { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
			const result = events.get("before_agent_start")!(event, { cwd }) as { message?: unknown } | void;
			const db = new DatabaseSync(join(cwd, ".agent/notes.db"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT body FROM notes WHERE kind = 'ask' ORDER BY id DESC LIMIT 1").get()?.body, prompt);
			} finally { db.close(); }
			return { event, result };
		},
	};
}

test("before_agent_start: full tools keeps every instruction (read + write)", async () => {
	const t = await setup(["note_list", "note_add"]);
	try {
		const { event } = t.beforeAgentStart("do the thing");
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
		const { event } = t.beforeAgentStart("scout this");
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
		const { event } = t.beforeAgentStart("record this");
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
		const { event, result } = t.beforeAgentStart("read only run");
		assert.equal(event.systemPromptOptions.sections.shared_notes, undefined);
		assert.equal(result, undefined); // no pending inbox message on a fresh project: no result returned either.
		const dbFile = join(t.cwd, ".agent", "notes.db");
		assert.ok(existsSync(dbFile), "ask must still be recorded even without note tools active");

	} finally {
		await t.cleanup();
	}
});
