import { runtimeRoot } from "../lib/runtime-paths.mjs";
import assert from "node:assert/strict";
import { closeSync, copyFileSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxArgs, sandboxBackend } from "../scripts/codex-shell.mjs";
import register from "../extensions/codex-sandbox/index.ts";

test("sandbox arguments preserve the entire shell program as one argument and never grant escalation", () => {
  const command = 'printf "%s" "quoted text"; false\nprintf done';
  const args = sandboxArgs(command, "/work/project", "/private/scratch", ["/outside/file"]);
  assert.equal(args.at(-1), command);
  assert.deepEqual(args.slice(-8), ["--", "/usr/bin/env", "PI_CONFINED=1", "/bin/bash", "--noprofile", "--norc", "-c", command]);
  const profile = args.find(value => value.startsWith("permissions="));
  for (const required of ['extends=":workspace"', '":slash_tmp"="read"', '"/private/scratch"="write"', '".pi"="read"', '"/outside/file"="write"', 'network={enabled=false}']) assert.ok(profile.includes(required), required);
  assert.ok(args.includes("features.network_proxy=false"));
  assert.equal(args.some(arg => arg.includes("sandbox_workspace_write")), false, "use the same explicit permission profile for offline and network commands");
});

test("backend selection prefers the private Linux repair and never replaces an explicit override", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-backend-"));
  try {
    const fallback = join(home, ".local/bin/codex");
    assert.equal(sandboxBackend({ HOME: home }), fallback);
    const directory = join(home, ".local/share/pi-codex/0.155.1-file-roots");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "codex"), "fixture");
    assert.equal(sandboxBackend({ HOME: home }), process.platform === "linux" ? join(directory, "codex") : fallback);
    assert.equal(sandboxBackend({ HOME: home, PI_CODEX_SANDBOX_BIN: "/explicit/missing" }), "/explicit/missing");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("explicit disposable metadata roots remain offline when passed through the launcher", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-offline-roots-"))), agent = join(root, "agent"), cwd = join(root, "repo"), home = join(root, "home");
  try {
    mkdirSync(join(agent, "scripts"), { recursive: true }); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd, ".git"));
    for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
    const backend = join(root, "backend.mjs");
    // This mock only records the launcher arguments; it executes no command.
    writeFileSync(backend, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    writeFileSync(join(agent, "network-policy.json"), '{"allow":["github.com"]}');
    const stdout = join(root, "out.log"), stderr = join(root, "err.log"), out = openSync(stdout, "w"), err = openSync(stderr, "w");
    let result;
    try {
      result = spawnSync(process.execPath, [join(agent, "scripts/codex-shell.mjs"), "--write-roots", JSON.stringify([join(cwd, ".git")]), "--read-roots", JSON.stringify([join(cwd, ".git/config")]), "--offline", "-c", "fixture-never-executed"], {
        cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: backend }, stdio: ["ignore", out, err], timeout: 10000,
      });
    } finally { closeSync(out); closeSync(err); }
    assert.ifError(result.error); assert.equal(result.status, 0, readFileSync(stderr, "utf8"));
    const args = JSON.parse(readFileSync(stdout, "utf8")), profile = args.find(arg => arg.startsWith("permissions="));
    assert.ok(args.includes("features.network_proxy=false")); assert.ok(profile.includes("network={enabled=false}"));
    assert.ok(profile.includes(`${JSON.stringify(join(cwd, ".git"))}="write"`));
    assert.ok(profile.includes(`${JSON.stringify(join(cwd, ".git/config"))}="read"`));
    assert.ok(!args.some(arg => arg.includes("github.com")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a relocated package reads network denials from the agent directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-package-policy-")));
  const agent = join(root, "agent"), runtime = join(agent, "packages/pi-agent-config"), cwd = join(root, "project"), home = join(root, "home");
  try {
    mkdirSync(join(runtime, "scripts"), { recursive: true }); mkdirSync(cwd); mkdirSync(home);
    for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(runtime, "scripts", name));
    writeFileSync(join(agent, "network-policy.json"), '{"allow":[],"deny":["example.com"]}');
    const backend = join(root, "backend"); writeFileSync(backend, "must never execute");
    const log = join(root, "denial.log"), fd = openSync(log, "w", 0o600);
    let result;
    try {
      result = spawnSync(process.execPath, [join(runtime, "scripts/codex-shell.mjs"), "--web-url", "https://example.com/page"], {
        cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: backend }, stdio: ["ignore", fd, fd], timeout: 10000,
      });
    } finally { closeSync(fd); }
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(readFileSync(log, "utf8"), /WEB_NETWORK_DENIED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox guard rejects project shell overrides and stale sessions, including before reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-guard-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const agent = process.env.PI_CODING_AGENT_DIR;
    const cwd = join(root, "project");
    mkdirSync(join(agent, "scripts"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
    writeFileSync(join(agent, "settings.json"), "{}");
    const handlers = new Map();
    register({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
    const ctx = { cwd, isProjectTrusted: () => true };
    const call = () => handlers.get("tool_call")({ toolName: "bash" }, ctx);
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined, "adapter is opt-in");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: launcher }));
    assert.equal((await call()).block, true, "disk change alone does not configure a cached shell");
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined);
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
    assert.equal((await call()).block, true);
    await handlers.get("session_start")({}, ctx);
    rmSync(join(cwd, ".pi/settings.json"));
    assert.equal((await call()).block, true, "removing an override also needs reload");
    await handlers.get("session_start")({}, ctx);
    assert.equal(await call(), undefined);
    assert.equal(await handlers.get("tool_call")({ toolName: "read" }, ctx), undefined);
    const inside = join(cwd, "child");
    const outside = join(root, "other-project");
    mkdirSync(inside); mkdirSync(outside);
    symlinkSync(outside, join(cwd, "escape"));
    const delegate = input => handlers.get("tool_call")({ toolName: "subagent", input }, ctx);
    assert.equal(await delegate({ cwd: inside }), undefined);
    for (const input of [{ cwd: outside }, { tasks: [{ cwd: outside }] }, { chain: [{ cwd: outside }] }, { cwd: join(cwd, "escape") }]) {
      assert.equal((await delegate(input)).block, true, "delegation cannot broaden the sandbox by changing cwd");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
