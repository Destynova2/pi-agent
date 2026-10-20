import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Grob registration streams through the installed Pi SDK and preserves each tier's reasoning mode", { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-grob-runtime-")), requests = [];
  let mode = "ok";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    if (new URL(req.url, "http://localhost").pathname !== "/v1/messages" || req.method !== "POST") return res.writeHead(404).end(`Unexpected fixture endpoint: ${req.method} ${req.url}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body, apiKey: req.headers["x-api-key"], authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (mode === "denied") return res.writeHead(403).end("fixture denial");
    if (mode === "redirect") return res.writeHead(307, { location: "https://api.anthropic.com/v1/messages" }).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const previous = process.env.GROB_URL;
  process.env.GROB_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env.GROB_URL; else process.env.GROB_URL = previous; });
  const { default: registerGrob, TIER_IDS } = await import("../extensions/grob/index.ts");
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, noSkills: true, noPromptTemplates: true, noThemes: true,
    settingsManager: SettingsManager.inMemory({ packages: [] }), additionalExtensionPaths: [resolve("extensions/grob/index.ts")] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "the actual Pi extension loader resolves the provider SDK imports");
  assert.ok(loader.getExtensions().extensions.length > 0);
  assert.ok(loader.getExtensions().extensions.some(extension => extension.commands.has("grob")), "the installed SDK exposes /grob as a user command");
  writeFileSync(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat-fixture-private", refresh: "fixture-refresh", expires: Date.now() + 86400000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const restored = [runtime.getModel("openai-codex", "gpt-6-astra"), runtime.getModel("openai", "gpt-6-astra"), runtime.getModel("anthropic", "claude-fable-5-1")];
  assert.ok(restored.every(Boolean), "fixture models exist in the installed SDK");
  registerGrob({ registerProvider: (provider, config) => typeof provider === "string" ? runtime.registerProvider(provider, config) : runtime.registerNativeProvider(provider), registerCommand() {}, on() {} });
  assert.equal(runtime.hasConfiguredAuth("grob"), true);
  for (const id of TIER_IDS) {
    const model = runtime.getModel("grob", id);
    assert.ok(model, `${id} registered`);
    const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }] },
      { maxTokens: 2048, reasoning: "medium", maxRetries: 0, signal: AbortSignal.timeout(3000) }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content.map(part => part.text), ["OK"]);
  }
  assert.deepEqual(requests.map(({ body }) => body.model), TIER_IDS);
  assert.ok(requests.every(({ body, apiKey }) => body.stream === true && apiKey === "grob"));
  assert.equal(requests[0].body.thinking, undefined);
  assert.equal(requests[1].body.thinking.type, "enabled");
  assert.equal(requests[2].body.thinking, undefined);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    assert.equal(new URL(input instanceof Request ? input.url : input).origin, process.env.GROB_URL, "no direct upstream request");
    return fetch(input, init);
  });
  for (const oldModel of restored) {
    assert.equal(runtime.getModel(oldModel.provider, oldModel.id).compat, undefined, "upstream API compatibility flags do not leak into the proxy protocol");
    for (const model of [oldModel, runtime.getModel(oldModel.provider, oldModel.id)]) {
      for (const method of ["stream", "streamSimple"]) {
        const result = await runtime[method](model, { messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }] },
          { maxTokens: 100, maxRetries: 0, headers: { Authorization: "Bearer private", Cookie: "private=value" }, signal: AbortSignal.timeout(3000) }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(requests.at(-1).body.model, model.id, "preserve explicit OpenAI/Anthropic model choice");
        assert.equal(requests.at(-1).apiKey, "grob");
        assert.equal(requests.at(-1).authorization, undefined);
        assert.equal(requests.at(-1).cookie, undefined);
      }
    }
  }
  for (mode of ["denied", "redirect"]) {
    for (const model of restored) {
      const before = requests.length;
      const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] },
        { maxTokens: 100, maxRetries: 0, signal: AbortSignal.timeout(3000) }).result();
      assert.equal(result.stopReason, "error");
      assert.equal(requests.length, before + 1, "one proxy request; no fallback");
    }
  }
});

test("invalid Grob configuration keeps protective provider overrides registered", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-grob-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.GROB_URL;
  process.env.GROB_URL = "https://api.openai.com";
  t.after(() => { if (previous === undefined) delete process.env.GROB_URL; else process.env.GROB_URL = previous; });
  const { default: registerGrob } = await import("../extensions/grob/index.ts?invalid-endpoint");
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const restored = runtime.getModel("openai-codex", "gpt-6-astra");
  registerGrob({ registerProvider: (provider, config) => typeof provider === "string" ? runtime.registerProvider(provider, config) : runtime.registerNativeProvider(provider), registerCommand() {}, on() {} });
  let network = 0;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("No request may leave Pi"); });
  const result = await runtime.streamSimple(restored, { messages: [{ role: "user", content: "private fixture", timestamp: Date.now() }] },
    { maxTokens: 100, maxRetries: 0, signal: AbortSignal.timeout(3000) }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(network, 0);
});
