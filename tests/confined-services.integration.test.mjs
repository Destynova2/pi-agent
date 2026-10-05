import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runConfined } from "../lib/confined.ts";
import { notesWritableRoots } from "../scripts/codex-shell.mjs";

const launcher = new URL("../scripts/codex-shell.mjs", import.meta.url).pathname;

test("workers refuse direct launches, including an inherited Codex marker", () => {
  for (const worker of ["confined-tool.mjs", "confined-lsp-worker.mjs"]) {
    const result = spawnSync(process.execPath, [
      "--import", new URL("../lib/resolve-pi.mjs", import.meta.url).pathname,
      "--import", new URL("../extensions/confined-lsp/pi-lsp-module-hook.mjs", import.meta.url).pathname,
      new URL(`../scripts/${worker}`, import.meta.url).pathname,
    ], { env: { ...process.env, PI_CONFINED: "", CODEX_SANDBOX: "inherited" }, input: "{}", encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires the Codex sandbox launcher/);
  }
});

test("real confined notes and Graphify preserve features without granting Bash their storage", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-confined-services-")));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const agent = join(root, "agent");
  for (const path of [cwd, join(home, "workspace"), agent]) mkdirSync(path, { recursive: true });
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODEX_SANDBOX_BIN: process.env.PI_CODEX_SANDBOX_BIN };
  const backend = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: backend });
  try {
    const init = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const request = input => runConfined(cwd, "notes", { cwd, agent: "fixture", ...input });
    await request({ op: "add", kind: "decision", body: "confined note" });
    await request({ op: "add", kind: "ask", body: "private prompt" });
    assert.match((await request({ op: "list" })).text, /private prompt/);
    const mirror = await request({ op: "list", scope: "all" });
    assert.match(mirror.text, /confined note/);
    assert.doesNotMatch(mirror.text, /private prompt/);
    assert.match(readFileSync(join(cwd, ".git/info/exclude"), "utf8"), /\.agent\//);
    const first = await request({ op: "inbox", afterId: 0 });
    await runConfined(cwd, "notes", { cwd, agent: "other", op: "add", kind: "msg", body: "@fixture hello" });
    assert.match((await request({ op: "inbox", afterId: first.lastId })).text, /hello/);
    await assert.rejects(request({ op: "list", limit: -1 }), /limit/);
    await assert.rejects(request({ op: "list", scope: "outside" }), /scope/);
    await assert.rejects(request({ op: "add", body: "missing kind" }), /kind/);
    for (const path of [join(home, "workspace/notes.db"), join(home, "workspace/not-notes"), join(cwd, ".git/config")]) {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(path)}, 'denied')`)}`;
      for (const profile of path.endsWith("/notes.db") ? ["--offline"] : ["--offline", "--notes"]) {
        const denied = spawnSync(launcher, [profile, "-c", command], { cwd, env: process.env, encoding: "utf8", timeout: 10000 });
        assert.notEqual(denied.status, 0, `${profile}: ${path}`);
        assert.match(denied.stderr, /EPERM|EACCES|EROFS|permitted|denied/);
      }
    }
    writeFileSync(join(cwd, "hello.js"), "export function hello(name) { return name; }\n");
    const graph = await runConfined(cwd, "graphify", { op: "graph", root: cwd, action: "overview" });
    assert.equal(graph.ok, true);
    assert.match(graph.text, /nodes \(local AST\)/);
    assert.ok(graph.graph.includes("pi-codex-sandbox"));
    assert.match(await runConfined(cwd, "git", { operation: "files" }), /hello\.js/);
    // Refuse storage indirection rather than widening a grant through a project symlink.
    rmSync(join(cwd, ".agent"), { recursive: true });
    symlinkSync(agent, join(cwd, ".agent"));
    assert.throws(() => notesWritableRoots(cwd), /links/);
    await assert.rejects(request({ op: "list" }), /links/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("confined notes preserve an existing central WAL database", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-notes-migration-")));
  const home = join(root, "home"), cwd = join(root, "project");
  mkdirSync(join(home, "workspace"), { recursive: true }); mkdirSync(cwd);
  const previous = { HOME: process.env.HOME, PI_CODEX_SANDBOX_BIN: process.env.PI_CODEX_SANDBOX_BIN };
  const backend = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  const db = new DatabaseSync(join(home, "workspace/notes.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes (id INTEGER PRIMARY KEY, project TEXT, agent TEXT, kind TEXT, body TEXT, created_at TEXT, rev TEXT); INSERT INTO notes VALUES (1, 'old', 'fixture', 'decision', 'preserved history', '2026-01-01', NULL)");
  db.close();
  Object.assign(process.env, { HOME: home, PI_CODEX_SANDBOX_BIN: backend });
  try {
    await runConfined(cwd, "notes", { cwd, agent: "fixture", op: "add", kind: "decision", body: "new history" });
    const result = await runConfined(cwd, "notes", { cwd, agent: "fixture", op: "list", scope: "all" });
    assert.match(result.text, /preserved history/);
    assert.match(result.text, /new history/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
