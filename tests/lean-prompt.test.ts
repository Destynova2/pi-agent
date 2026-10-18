import { test } from "node:test";
import assert from "node:assert/strict";
import leanPrompt, { briefDescription, DEFERRED_TOOLS, MAX_BRIEF_LENGTH } from "../extensions/lean-prompt/index.ts";

test("keeps the first sentence and the Use-when routing hint", () => {
  const long = "Audit code quality with weighted scoring across 12 dimensions (naming, complexity). Detects named anti-patterns (Fowler taxonomy). Use when reviewing code quality or checking for smells. Outputs a scored report.";
  assert.equal(briefDescription(long), "Audit code quality with weighted scoring across 12 dimensions (naming, complexity). Use when reviewing code quality or checking for smells.");
  assert.equal(briefDescription("Extract text from PDF files."), "Extract text from PDF files.");
  assert.equal(briefDescription("  Single   line without period "), "Single line without period");
});

test("caps the brief with an ellipsis", () => {
  const brief = briefDescription(`${"word ".repeat(80)}end.`);
  assert.equal(brief.length, MAX_BRIEF_LENGTH);
  assert.ok(brief.endsWith("…"));
});

/** Minimal ExtensionAPI stand-in: handlers, registered tools and the active set. */
function fakePi(active: string[]) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  let current = [...active];
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [...current],
    setActiveTools: (names: string[]) => { current = [...names]; },
  };
  return { pi, handlers, tools, active: () => current };
}

test("deferred tools stay dormant until load_tools activates them", async () => {
  const names = Object.keys(DEFERRED_TOOLS);
  const { pi, handlers, tools, active } = fakePi(["read", "bash", ...names]);
  leanPrompt(pi as any);
  const start = handlers.get("before_agent_start")![0];
  const sections: Record<string, string> = { podman_bridge: "podman rules", confined_tools: "stays" };
  start({ systemPromptOptions: { sections, skills: [{ name: "s", description: "First. Use when needed. Third." }] } });
  assert.deepEqual(active(), ["read", "bash"]);
  assert.deepEqual(sections, { confined_tools: "stays" });

  const loader = tools.get("load_tools");
  assert.equal(loader.exposure, "model-only");
  await assert.rejects(loader.execute("1", { tools: ["bash"] }), /Unknown deferred tools: bash/);
  const result = await loader.execute("2", { tools: ["request_podman_access", "model_catalog"] });
  assert.match(result.content[0].text, /Loaded: request_podman_access, model_catalog\.\n\npodman rules/);
  assert.deepEqual(active(), ["read", "bash", "request_podman_access", "model_catalog"]);

  // Later turns keep what was loaded and keep the rest dormant; the loaded section returns to the prompt.
  const again: Record<string, string> = { podman_bridge: "podman rules", git_initialization: "init rules" };
  pi.setActiveTools(["read", "bash", ...names]);
  start({ systemPromptOptions: { sections: again, skills: [] } });
  assert.deepEqual(active(), ["read", "bash", "request_podman_access", "model_catalog"]);
  assert.deepEqual(again, { podman_bridge: "podman rules" });
});
