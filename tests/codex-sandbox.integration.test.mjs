import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager, createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const launcherSource = fileURLToPath(new URL("../scripts/codex-shell.mjs", import.meta.url));
const installedNpm = join(getAgentDir(), "npm");
const backgroundExtension = fileURLToPath(new URL("../extensions/background-bash/index.ts", import.meta.url));

test("Codex shell enforces boundaries through native and background Bash without model calls", { skip: !["darwin", "linux"].includes(process.platform), timeout: 40000 }, async () => {
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  assert.ok(existsSync(join(installedNpm, "node_modules/@richardgill/pi-background-bash")), "Install the configured pi-background-bash package first");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-codex-integration-")));
  const project = join(root, "project");
  const agent = join(root, "agent");
  const home = join(root, "home");
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODEX_SANDBOX_BIN: process.env.PI_CODEX_SANDBOX_BIN, LC_ALL: process.env.LC_ALL };
  let extension;
  let ctx;
  try {
    for (const path of [project, agent, home, join(root, "outside"), join(agent, "scripts"), join(project, ".git"), join(project, ".codex"), join(project, ".agents")]) mkdirSync(path, { recursive: true });
    symlinkSync(installedNpm, join(agent, "npm"));
    const launcher = join(agent, "scripts/codex-shell.mjs");
    copyFileSync(launcherSource, launcher);
    copyFileSync(new URL("../scripts/codex-network.mjs", import.meta.url), join(agent, "scripts/codex-network.mjs"));
    copyFileSync(new URL("../scripts/metal-backend.mjs", import.meta.url), join(agent, "scripts/metal-backend.mjs"));
    chmodSync(launcher, 0o755);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: launcher }));
    symlinkSync(join(root, "outside"), join(project, "escape"));
    writeFileSync(join(root, "outside/readable.txt"), "outside reads are not isolated");
    // Repository configuration must not widen the explicit shell policy.
    writeFileSync(join(project, ".codex/config.toml"), 'sandbox_mode="danger-full-access"\n[sandbox_workspace_write]\nnetwork_access=true\nwritable_roots=["/"]\n');
    writeFileSync(join(project, "boundaries.mjs"), `
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
if (process.platform === 'darwin') assert.equal(process.env.CODEX_SANDBOX, 'seatbelt');
assert.equal(process.env.PI_CONFINED, '1');
if (process.platform === 'linux') assert.equal(existsSync('/dev/kvm'), false, 'ordinary Bash must not inherit KVM access');
writeFileSync('inside.txt', 'inside');
writeFileSync(process.env.TMPDIR + '/scratch.txt', 'scratch');
for (const path of ['../outside/relative.txt', ${JSON.stringify(join(root, "outside/absolute.txt"))}, 'escape/link.txt', '.git/blocked.txt', '.codex/blocked.txt', '.agents/blocked.txt']) {
  assert.throws(() => writeFileSync(path, 'blocked'), error => ['EPERM', 'EACCES', 'EROFS'].includes(error.code), path);
}
const child = spawnSync('/bin/sh', ['-c', 'printf blocked > ../outside/child.txt'], { encoding: 'utf8' });
assert.notEqual(child.status, 0);
assert.match(child.stderr, /not permitted|Permission denied|Read-only file system/i);
assert.equal(readFileSync('../outside/readable.txt', 'utf8'), 'outside reads are not isolated');
await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', error => {
    try { assert.ok(['EPERM', 'EACCES'].includes(error.code), error.message); resolve(); } catch (error) { reject(error); }
  });
  server.listen(0, '127.0.0.1', () => server.close(() => {
    // Linux may bind loopback inside its isolated network namespace.
    try {
      assert.equal(process.platform, 'linux', 'Network binding allowed outside Linux');
      assert.notEqual(readlinkSync('/proc/self/ns/net'), ${JSON.stringify(process.platform === "linux" ? readlinkSync("/proc/self/ns/net") : null)}, 'Sandbox must not share the host network namespace');
      resolve();
    } catch (error) { reject(error); }
  }));
});
console.log('boundaries passed');
`);
    Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: codex, LC_ALL: "C" });
    const shellCommand = `${quote(process.execPath)} boundaries.mjs`;
    const direct = spawnSync(launcher, ["-c", shellCommand], { cwd: project, env: process.env, encoding: "utf8", timeout: 15000 });
    assert.ifError(direct.error);
    assert.equal(direct.status, 0, direct.stderr + direct.stdout);
    assert.match(direct.stdout, /boundaries passed/);
    const stdio = spawnSync(launcher, ["-c", `${quote(process.execPath)} -e 'console.log(require("fs").readFileSync(0,"utf8").trim()); console.error("stderr intact")'`], {
      cwd: project, env: process.env, encoding: "utf8", input: "stdin intact\n", timeout: 10000,
    });
    assert.ifError(stdio.error);
    assert.equal(stdio.status, 0, stdio.stderr);
    assert.equal(stdio.stdout, "stdin intact\n");
    assert.match(stdio.stderr, /stderr intact/);
    const failed = spawnSync(launcher, ["-c", "exit 37"], { cwd: project, env: process.env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 37, failed.stderr);
    const unavailable = spawnSync(launcher, ["-c", "touch must-not-exist"], { cwd: project, env: { ...process.env, PI_CODEX_SANDBOX_BIN: join(root, "missing") }, encoding: "utf8", timeout: 10000 });
    assert.notEqual(unavailable.status, 0);
    assert.equal(existsSync(join(project, "must-not-exist")), false);

    ctx = { cwd: project, hasUI: false, isProjectTrusted: () => true, ui: {}, sessionManager: { getSessionId: () => "sandbox-test", getSessionFile: () => undefined } };
    const native = createBashToolDefinition(project, { shellPath: launcher });
    const nativeResult = await native.execute("native", { command: shellCommand }, undefined, undefined, ctx);
    assert.match(nativeResult.content[0].text, /boundaries passed/);
    const refused = await native.execute("denied", { command: "printf blocked > ../outside/native.txt" }, undefined, undefined, ctx);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /not permitted|Permission denied|Read-only file system/i);
    assert.equal(existsSync(join(root, "outside/native.txt")), false);

    const loader = new DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [backgroundExtension] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    loaded.runtime.getThinkingLevel = () => "off";
    let complete;
    loaded.runtime.sendMessage = message => complete?.(message);
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
    assert.equal(extension.tools.has("bash"), false, "foreground execution stays native");
    const bash = extension.tools.get("bash_background").definition;
    const processes = extension.tools.get("bash_process").definition;
    const done = new Promise(resolve => { complete = resolve; });
    const background = await bash.execute("background", { command: shellCommand }, undefined, undefined, ctx);
    assert.ok(background.details.pgid > 0);
    const message = await done;
    assert.equal(message.details.status, "success", message.content);
    assert.match(message.content, /boundaries passed/);

    const sleeper = 'printf ready > sleeper.ready; exec /bin/sleep 30';
    const waiting = await bash.execute("kill", { command: sleeper }, undefined, undefined, ctx);
    // Wait only for fixture readiness; no provider or external service is involved.
    for (let i = 0; i < 100 && !existsSync(join(project, "sleeper.ready")); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(readFileSync(join(project, "sleeper.ready"), "utf8"), "ready");
    // Shell $$ can be namespace-local on Linux; check the host process group.
    const processGroup = -waiting.details.pgid;
    const peek = await processes.execute("peek", { action: "peek", pgid: waiting.details.pgid }, undefined, undefined, ctx);
    assert.equal(peek.details.active, true);
    const killed = await processes.execute("stop", { action: "kill", pgid: waiting.details.pgid }, undefined, undefined, ctx);
    assert.match(killed.content[0].text, /Killed background process/);
    for (let i = 0; i < 100; i++) {
      try { process.kill(processGroup, 0); } catch (error) {
        if (error.code === "ESRCH") break;
        // Darwin may report EPERM while a killed group still contains zombies.
        // Yield for reaping; the final assertion still requires actual ESRCH.
        if (process.platform !== "darwin" || error.code !== "EPERM") throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(processGroup, 0), error => error.code === "ESRCH");
    await assert.rejects(native.execute("timeout", { command: "/bin/sleep 30", timeout: 1 }, undefined, undefined, ctx), /timed out|timeout/i);
    const listed = await processes.execute("list", { action: "list" }, undefined, undefined, ctx);
    assert.match(listed.content[0].text, /No active background processes/);
  } finally {
    if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
