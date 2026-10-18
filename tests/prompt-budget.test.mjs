import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { DEFERRED_SECTIONS, DEFERRED_TOOLS } from "../extensions/lean-prompt/index.ts";

// Notes recall crosses the sandbox process boundary, which Pi's loader cannot mock; load that one
// extension through Node with the boundary stubbed (as tests/notes-recall does) and an empty memory.
const confined = new URL("../lib/confined.ts", import.meta.url).href;
const hook = registerHooks({
  load(url, context, next) {
    if (url === confined) return { format: "module", shortCircuit: true,
      source: "export const runConfined = async (_cwd, _service, input) => input.op === \"list\" ? { op: \"list\", text: \"(no notes)\" } : { op: \"inbox\", project: \"project\", lastId: 0 };" };
    return next(url, context);
  },
});
const { default: registerNotes } = await import("../extensions/notes.ts");
hook.deregister();

// harness2's always_on_max, as a gate: this package's always-on prompt text (sections, plus the
// descriptions and guidelines of the tools active on the first call) may not grow past this many
// characters. Adding prose means cutting prose. Measured 29,999 on 2026-10-18 (docs/PERFORMANCE.md);
// raise the cap only with a new measurement there.
export const ALWAYS_ON_MAX = 30_000;

test("always-on prompt text stays under the budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompt-budget-"));
  const agent = join(root, "agent"), cwd = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    mkdirSync(agent); mkdirSync(cwd);
    writeFileSync(join(agent, "tool-policy.json"), '{"*":"allow"}');
    // The strict sandbox's verify() wants the configured shell to be this source tree's launcher.
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: new URL("../scripts/codex-shell.mjs", import.meta.url).pathname }));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: agent, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: pkg.pi.extensions.filter(path => !path.endsWith("/notes.ts")).map(path => new URL(`../${path}`, import.meta.url).pathname),
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    // Only the extension wrapping an npm package of the installed agent directory may be absent here; its text is small.
    assert.deepEqual(loaded.errors.map(e => e.path.split("/extensions/")[1]), ["background-bash/index.ts"]);
    const tools = new Map();
    for (const extension of loaded.extensions) for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
    const notesHandlers = new Map();
    registerNotes({ on: (name, fn) => notesHandlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {},
      getActiveTools: () => [...active], sendMessage() {}, appendEntry() {} });
    // The shared runtime every extension API delegates to; only the active-tool set is bound here.
    let active = [...tools.keys()];
    loaded.runtime.getActiveTools = () => [...active];
    loaded.runtime.setActiveTools = names => { active = [...names]; };
    const ctx = { cwd, hasUI: false, mode: "rpc", isProjectTrusted: () => false, ui: { notify() {}, confirm() { assert.fail("no prompts"); }, select() { assert.fail("no prompts"); } } };
    const event = { prompt: "", systemPromptOptions: { sections: {}, skills: [], toolGuidelines: [] } };
    const failures = [];
    for (const extension of loaded.extensions) {
      // Only the sandbox dispatcher's session_start is needed (it pins cwd and shell); the others open workers.
      if (extension.path.endsWith("/tool-policy/index.ts")) for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      for (const handler of extension.handlers.get("before_agent_start") ?? []) {
        try { await handler(event, ctx); } catch (error) { failures.push(`${extension.path.split("/extensions/")[1]}: ${error.message.split("\n")[0]}`); }
      }
    }
    await notesHandlers.get("session_start")({}, ctx);
    await notesHandlers.get("before_agent_start")(event, ctx);
    assert.deepEqual(failures, []);
    for (const name of Object.keys(DEFERRED_TOOLS)) { assert.ok(tools.has(name), `${name} registered`); assert.ok(!active.includes(name), `${name} dormant`); }
    for (const key of Object.keys(DEFERRED_SECTIONS)) assert.equal(event.systemPromptOptions.sections[key], undefined, `${key} stashed`);
    const sections = Object.values(event.systemPromptOptions.sections).join("\n");
    const perTool = active.filter(name => tools.has(name)).map(name => { const t = tools.get(name); return (t.description ?? "") + (t.promptGuidelines ?? []).join(""); }).join("");
    const total = sections.length + perTool.length;
    console.log(`always-on: sections ${sections.length} + tools ${perTool.length} = ${total} chars (${active.length} active tools, cap ${ALWAYS_ON_MAX})`);
    assert.ok(total <= ALWAYS_ON_MAX, `always-on text ${total} > ${ALWAYS_ON_MAX}: cut prose or justify a new cap in docs/PERFORMANCE.md`);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
