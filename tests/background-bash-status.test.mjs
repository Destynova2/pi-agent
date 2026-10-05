import assert from "node:assert/strict";
import { test, after } from "node:test";
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommandAccess } from "../extensions/tool-policy/command-access.ts";
import { ORIGINAL_SHA256, patchBackgroundBash, transformBackgroundBash } from "../scripts/patch-background-bash.mjs";

// Reconstruct a pristine, hash-verified fixture from the installed package, even
// when its foreground-status patch is already applied. Never mutate the runtime.
const original = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-pristine-")));
after(() => rmSync(original, { recursive: true, force: true }));
cpSync(process.env.PI_BACKGROUND_BASH_SOURCE ?? join(getAgentDir(), "npm/node_modules/@richardgill/pi-background-bash"), original, { recursive: true });
const sourcePath = join(original, "src/tools.ts");
const source = readFileSync(sourcePath, "utf8");
const digest = text => createHash("sha256").update(text).digest("hex");
const pristine = digest(source) === ORIGINAL_SHA256 ? source : transformBackgroundBash(source, true);
assert.equal(digest(pristine), ORIGINAL_SHA256, "Unknown installed background-bash content");
writeFileSync(sourcePath, pristine);
rmSync(`${sourcePath}.before-pi-exit-status`, { force: true });

test("pinned patch rejects unknown content/version, backs up and is idempotent", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-status-patch-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(original, root, { recursive: true });
  assert.equal(createHash("sha256").update(readFileSync(join(root, "src/tools.ts"))).digest("hex"), ORIGINAL_SHA256);
  assert.equal((await patchBackgroundBash(root)).patched, true);
  assert.equal((await patchBackgroundBash(root)).patched, false);
  assert.equal(createHash("sha256").update(readFileSync(join(root, "src/tools.ts.before-pi-exit-status"))).digest("hex"), ORIGINAL_SHA256);
  writeFileSync(join(root, "src/tools.ts"), readFileSync(join(root, "src/tools.ts"), "utf8") + "\n// unknown edit\n");
  await assert.rejects(patchBackgroundBash(root), /Modified/);
  writeFileSync(join(root, "package.json"), '{"name":"@richardgill/pi-background-bash","version":"0.0.4"}');
  await assert.rejects(patchBackgroundBash(root), /Only/);
});

test("linked targets/backups and oversized metadata are refused without mutation", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-status-links-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(original, root, { recursive: true });
  const target = join(root, "src/tools.ts"), backup = `${target}.before-pi-exit-status`, saved = readFileSync(target), other = join(root, "original.ts");
  writeFileSync(other, saved); rmSync(target); symlinkSync(other, target);
  await assert.rejects(patchBackgroundBash(root), /Linked/);
  rmSync(target); linkSync(other, target);
  await assert.rejects(patchBackgroundBash(root), /Linked/);
  rmSync(target); writeFileSync(target, saved); symlinkSync(other, backup);
  await assert.rejects(patchBackgroundBash(root), /Linked/);
  assert.deepEqual(readFileSync(target), saved); rmSync(backup);
  writeFileSync(join(root, "package.json"), " ".repeat(1024 * 1024 + 1));
  await assert.rejects(patchBackgroundBash(root), /oversized/);
});

test("real SDK + package propagate failed foreground exits, preserve successful text, background failure and cancellation", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-status-sdk-"))), pkg = join(root, "package"), agent = join(root, "agent");
  mkdirSync(agent); cpSync(original, pkg, { recursive: true }); await patchBackgroundBash(pkg);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "fixture.ts");
  writeFileSync(entry, `import { registerTools } from ${JSON.stringify(join(pkg, "src/tools.ts"))};
export default function(pi) {
  const manager = {
    getCommandPrefix: () => undefined,
    prepare(meta) {
      const managed = { pgid: 42, logPath: ${JSON.stringify(join(root, "fixture.log"))}, startedAt: Date.now(), command: meta.command };
      return { spawned: Promise.resolve(managed), operations: { exec: async () => {
        meta.onData(Buffer.from("fixture output: operation not permitted\\n"));
        if (meta.command === "cancel") throw new Error("aborted");
        if (meta.command === "timeout") throw new Error("timeout:1");
        managed.exitCode = meta.command === "ok" ? 0 : meta.command === "unknown" ? undefined : 7;
        return { exitCode: managed.exitCode ?? 0 };
      } } };
    },
    finishForeground() {},
    handoff(managed, notify) { managed.completion.then(outcome => notify(managed, outcome)); },
  };
  registerTools({ ...pi, getThinkingLevel: () => "off", sendMessage: message => { globalThis.__bashStatusCompletion = message; } }, manager,
    { bashToolName: "bash", processToolName: "bash_process", bashToolDescription: "fixture", processToolDescription: "fixture", systemPrompt: false, defaultTimeoutSeconds: 1, maxTimeoutSeconds: 2, defaultTimeoutAction: "kill" });
}
`);
  const previous = process.env.PI_CODING_AGENT_DIR, home = process.env.HOME; process.env.PI_CODING_AGENT_DIR = agent;
  process.env.HOME = join(root, "home"); mkdirSync(process.env.HOME);
  t.after(() => { delete globalThis.__bashStatusCompletion; if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: agent, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
  await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get("bash").definition;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } };
  const run = args => tool.execute("fixture-call", args, undefined, undefined, ctx);
  const success = await run({ command: "ok" }); assert.match(success.content[0].text, /operation not permitted/);
  for (const timeoutAction of ["kill", "background"]) await assert.rejects(run({ command: "failed", timeoutAction }), /Command exited with code 7/);
  await assert.rejects(run({ command: "cancel" }), /Command aborted/);
  await assert.rejects(run({ command: "timeout" }), /timed out/);
  await assert.rejects(run({ command: "unknown" }), /without an exit code/);
  const result = await run({ command: "failed", background: true }); assert.equal(result.details.active, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalThis.__bashStatusCompletion.details.status, "failed"); assert.equal(globalThis.__bashStatusCompletion.details.exitCode, 7);
  assert.match(globalThis.__bashStatusCompletion.content, /fixture output/);

  // Exercise the real command-access hooks: an actual SDK/package rejection becomes
  // eligible, but human refusal still prevents any command dispatch or extra rights.
  const handlers = new Map(); let access, prompts = 0;
  registerCommandAccess({ on: (name, handler) => handlers.set(name, handler), registerTool: definition => { access = definition; }, getActiveTools: () => ["request_command_access"] }, agent, () => {});
  const accessCtx = { ...ctx, hasUI: true, ui: { confirm: async () => { prompts++; return false; } } };
  await handlers.get("session_start")({}, accessCtx);
  const input = { command: "failed", timeoutAction: "kill" };
  handlers.get("tool_call")({ toolName: "bash", toolCallId: "observed-failure", input }, accessCtx);
  let failure; try { await run(input); } catch (error) { failure = error; }
  assert.match(failure.message, /code 7/);
  const captured = handlers.get("tool_result")({ toolName: "bash", toolCallId: "observed-failure", input, isError: true, content: [{ type: "text", text: failure.message }] }, accessCtx);
  assert.match(captured.content.at(-1).text, /failed_call_id="observed-failure"/);
  await assert.rejects(access.execute("request", { failed_call_id: "observed-failure", write_paths: [join(root, "extra")], reason: "fixture" }, undefined, undefined, accessCtx), /refused/);
  assert.equal(prompts, 1); await handlers.get("session_shutdown")();
});
