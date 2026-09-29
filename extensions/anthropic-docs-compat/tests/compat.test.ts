import { test } from "node:test";
import assert from "node:assert/strict";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { documentationGuide, registerDocsCompat } from "../compat.ts";

const paths = { readme: "/install path/README.md", docs: "/install path/docs", examples: "/install path/examples" };

function harness(provider = "anthropic", hasUI = true) {
  let handler: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => void) | undefined;
  let reset: (() => void) | undefined;
  const warnings: string[] = [];
  registerDocsCompat({ on: (name: string, fn: unknown) => {
    if (name === "before_agent_start") handler = fn as typeof handler;
    else if (name === "session_start") reset = fn as typeof reset;
    else assert.fail(`unexpected event ${name}`);
  } } as unknown as ExtensionAPI, paths);
  assert.ok(handler);
  assert.ok(reset);
  const ctx = { model: { provider }, hasUI, ui: { notify: (message: string, level: string) => {
    assert.equal(level, "warning"); warnings.push(message);
  } } } as unknown as ExtensionContext;
  return { run: (event: BeforeAgentStartEvent) => handler!(event, ctx), reset, warnings };
}

function event(systemPrompt = "Arbitrary future Pi prompt"): BeforeAgentStartEvent {
  return {
    type: "before_agent_start", prompt: "test", systemPrompt,
    systemPromptOptions: {
      cwd: "/tmp", sections: { project_context: "DO NOT DELETE" }, selectedTools: ["read"],
      toolSnippets: {}, toolGuidelines: {}, promptGuidelines: ["Never publish without approval."],
      appendSystemPrompt: "Additional user instructions.",
      contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }], skills: [],
    },
  };
}

test("builds a compact guide from installation paths with no prose parsing", () => {
  const guide = documentationGuide(paths);
  for (const part of [...Object.values(paths), "index.md", "not cwd", "fully", "linked Markdown"]) {
    assert.ok(guide.includes(part), part);
  }
  assert.ok(guide.length < 800);
});

test("handles changed or missing prompt prose without depending on phrases or line counts", () => {
  for (const prompt of ["", "Entirely new prompt", "<docs>Changed format</docs>"]) {
    const h = harness();
    const e = event(prompt);
    h.run(e);
    assert.equal(e.systemPromptOptions.sections.docs, documentationGuide(paths));
    assert.equal(e.systemPrompt, prompt);
    assert.deepEqual(h.warnings, []);
  }
});

test("only modifies the Anthropic docs section, preserving all other options", () => {
  for (const provider of ["anthropic", "openai-codex"]) {
    const h = harness(provider);
    const e = event();
    const expected = structuredClone(e);
    if (provider === "anthropic") expected.systemPromptOptions.sections.docs = documentationGuide(paths);
    assert.equal(h.run(e), undefined);
    assert.deepEqual(e, expected);
    assert.deepEqual(h.warnings, []);
  }
});

test("custom and forced prompts are untouched and do not trigger warnings", () => {
  const h = harness();
  for (const override of [{ sections: { docs: "custom" } }, { sections: { docs: "" } }, { customPrompt: "Custom" }, { forceSystemPrompt: "Exact" }]) {
    const e = event();
    Object.assign(e.systemPromptOptions, override);
    const before = structuredClone(e);
    h.run(e);
    assert.deepEqual(e, before);
  }
  assert.deepEqual(h.warnings, []);
});

test("repeated turns do not accumulate documentation", () => {
  const h = harness();
  const e = event();
  h.run(e);
  const before = structuredClone(e);
  h.run(e);
  assert.deepEqual(e, before);
  assert.deepEqual(h.warnings, []);
});

test("incompatible API warns once per session, leaving the input untouched", () => {
  const h = harness();
  const e = { type: "before_agent_start", prompt: "test", systemPrompt: "unchanged" } as BeforeAgentStartEvent;
  const before = structuredClone(e);
  h.run(e); h.run(e);
  assert.deepEqual(e, before);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /patch not applied/);
  h.reset(); h.run(e);
  assert.equal(h.warnings.length, 2);
});

test("incompatible sections are reported instead of overwritten", () => {
  const h = harness();
  const e = event();
  Object.assign(e.systemPromptOptions, { sections: null });
  h.run(e);
  assert.equal(e.systemPromptOptions.sections, null);
  assert.equal(h.warnings.length, 1);
});

test("headless mode reports incompatible API to stderr", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const h = harness("anthropic", false);
  const e = { type: "before_agent_start", prompt: "test", systemPrompt: "unchanged" } as BeforeAgentStartEvent;
  h.run(e); h.run(e);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /patch not applied/);
  assert.deepEqual(h.warnings, []);
});
