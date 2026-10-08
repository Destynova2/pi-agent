import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

const adapter = fileURLToPath(new URL("../extensions/background-bash/core.ts", import.meta.url));

test("native foreground Bash preserves real exit status without interpreting output text", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-native-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tool = createBashToolDefinition(cwd);
  const success = await tool.execute("ok", { command: "printf 'operation not permitted'" });
  assert.equal(success.isError, undefined);
  assert.match(success.content[0].text, /operation not permitted/);
  const failed = await tool.execute("failed", { command: "printf 'fixture output'; exit 7" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /code 7/);
  await assert.rejects(tool.execute("timeout", { command: "sleep 30", timeout: 1 }), /timed out|timeout/i);
  await assert.rejects(tool.execute("cancel", { command: "sleep 30" }, AbortSignal.abort()), /abort/i);
});

test("public background factory keeps completion, cancellation and cleanup without replacing native bash", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-background-")), agent = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agent); await mkdir(cwd);
  const require = createRequire(join(getAgentDir(), "npm/package.json"));
  const exported = process.env.PI_BACKGROUND_BASH_SOURCE
    ? createRequire(join(process.env.PI_BACKGROUND_BASH_SOURCE, "package.json")).resolve("@richardgill/pi-background-bash")
    : require.resolve("@richardgill/pi-background-bash");
  const before = await readFile(exported);
  const entry = join(root, "fixture.ts");
  await writeFile(entry, `import { backgroundBash } from ${JSON.stringify(exported)};
import { registerBackground } from ${JSON.stringify(adapter)};
export default function(pi) {
  registerBackground({ ...pi, getThinkingLevel: () => "off", sendMessage: message => globalThis.__backgroundMessages.push(message) }, backgroundBash, ${JSON.stringify(join(root, "logs"))});
}`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  globalThis.__backgroundMessages = [];
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__backgroundMessages;
    await rm(root, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
  await loader.reload();
  const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0], tool = extension.tools.get("bash_background").definition;
  assert.equal(extension.tools.has("bash"), false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["command", "name"]);
  const processTool = extension.tools.get("bash_process").definition;
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } };
  for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
  try {
    for (const [command, status, exitCode] of [["printf 'success'; exit 0", "success", 0], ["printf 'failed output'; exit 7", "failed", 7]]) {
      const count = globalThis.__backgroundMessages.length;
      const started = await tool.execute("start", { command }, undefined, undefined, ctx);
      assert.equal(started.details.active, true);
      const deadline = Date.now() + 5000;
      while (globalThis.__backgroundMessages.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const message = globalThis.__backgroundMessages[count];
      assert.ok(message, "background completion must arrive");
      assert.equal(message.details.exitCode, exitCode);
      assert.equal(message.details.status, status);
    }
    const count = globalThis.__backgroundMessages.length;
    const active = await tool.execute("long", { command: "sleep 30" }, undefined, undefined, ctx);
    await processTool.execute("stop", { action: "kill", pgid: active.details.pgid }, undefined, undefined, ctx);
    assert.equal(globalThis.__backgroundMessages.length, count, "intentional kill does not wake the model");
    await tool.execute("shutdown", { command: "sleep 30" }, undefined, undefined, ctx);
  } finally { for (const handler of extension.handlers.get("session_shutdown")) await handler({}, ctx); }
  const stopped = await processTool.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.match(stopped.content[0].text, /No active/);
  assert.deepEqual(await readFile(exported), before, "public factory source is unchanged");
});
