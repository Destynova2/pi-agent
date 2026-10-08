import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../lib/process.ts";
import { inspectGit, performGit, gitOperationArgs, gitWritePaths, validateGitRequest } from "../extensions/tool-policy/git-access-core.ts";
import { registerGitAccess } from "../extensions/tool-policy/git-access.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "git-access-"))), cwd = join(base, "repo"), agent = join(base, "agent"), home = join(base, "home");
  for (const path of [cwd, agent, home]) mkdirSync(path);
  const previous = Object.fromEntries(["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(base, { recursive: true, force: true }); });
  const request = input => validateGitRequest({ reason: "isolated fixture", ...input });
  const run = async input => { const value = request(input); return performGit(cwd, value, await inspectGit(cwd, value)); };
  return { base, cwd, agent, home, git, request, run };
}

test("Git request grammar excludes broad staging, arbitrary flags, destructive operations and malformed fields", () => {
  for (const request of [{ operation: "reset" }, { operation: "stage", paths: ["."] }, { operation: "stage", paths: ["../other"] }, { operation: "stage", paths: [".git/config"] }, { operation: "branch", branch: "-f" }, { operation: "branch", branch: "@{-1}" }, { operation: "push", branch: "main", remote: "--mirror" }, { operation: "commit", paths: ["x"], message: "m", noVerify: true }]) assert.throws(() => validateGitRequest({ reason: "test", ...request }));
  assert.deepEqual(validateGitRequest({ operation: "stage", paths: ["literal*file", "-filename"], reason: "test" }).paths, ["literal*file", "-filename"]);
});

test("real fixture Git can stage explicit files, commit with hooks, and create a new branch without tracking config writes", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "file"), "one\n"); writeFileSync(join(f.cwd, "unrelated"), "leave alone\n");
  writeFileSync(join(f.cwd, ".git/hooks/pre-commit"), "#!/bin/sh\nprintf checked > hook-proof\n", { mode: 0o755 });
  await f.run({ operation: "stage", paths: ["file"] });
  const result = await f.run({ operation: "commit", paths: ["file"], message: "fix: fixture" });
  assert.equal(result.hooksChangedTree, false); assert.equal(readFileSync(join(f.cwd, "hook-proof"), "utf8"), "checked");
  assert.equal(f.git("show", "--format=", "--name-only", "HEAD"), "file");
  const config = readFileSync(join(f.cwd, ".git/config"), "utf8");
  await f.run({ operation: "branch", branch: "fix/scoped" });
  assert.equal(f.git("branch", "--show-current"), "fix/scoped"); assert.equal(readFileSync(join(f.cwd, ".git/config"), "utf8"), config);
  const snapshot = await inspectGit(f.cwd, f.request({ operation: "stage", paths: ["file"] }));
  assert.ok(gitWritePaths(snapshot, f.request({ operation: "stage", paths: ["file"] })).every(path => !path.endsWith("config") && !path.endsWith("hooks") && path !== snapshot.gitDir));
});

test("pending file/index changes, extra staged paths, directories and failing hooks prevent a commit", async t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "file"), "one\n");
  const stage = f.request({ operation: "stage", paths: ["file"] }), before = await inspectGit(f.cwd, stage);
  writeFileSync(join(f.cwd, "file"), "changed\n");
  await assert.rejects(performGit(f.cwd, stage, before), /state changed/);
  await f.run(stage);
  writeFileSync(join(f.cwd, "other"), "unrelated\n"); f.git("add", "--", "other");
  await assert.rejects(inspectGit(f.cwd, f.request({ operation: "commit", paths: ["file"], message: "fix: fixture" })), /index does not match/);
  mkdirSync(join(f.cwd, "directory")); await assert.rejects(inspectGit(f.cwd, f.request({ operation: "stage", paths: ["directory"] })), /Linked, special/);
  writeFileSync(join(f.cwd, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(f.run({ operation: "commit", paths: ["file", "other"], message: "fix: fixture" }));
  assert.equal(f.git("rev-parse", "--revs-only", "HEAD"), "");
  writeFileSync(join(f.cwd, ".git/MERGE_HEAD"), "a".repeat(40));
  await assert.rejects(inspectGit(f.cwd, f.request({ operation: "commit", paths: ["file", "other"], message: "fix: fixture" })), /unfinished Git operation/);
});

test("push captures one credential-free HTTPS URL and an immutable tip, without force, tags or upstream changes", async t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "file"), "one\n");
  await f.run({ operation: "stage", paths: ["file"] }); await f.run({ operation: "commit", paths: ["file"], message: "fix: fixture" });
  f.git("remote", "add", "origin", "https://github.com/fixture/project.git");
  const request = f.request({ operation: "push", remote: "origin", branch: "fix/scoped" }), snapshot = await inspectGit(f.cwd, request);
  assert.equal(snapshot.remoteUrl, "https://github.com/fixture/project.git");
  assert.deepEqual(gitOperationArgs(request, snapshot), ["-c", "remote.origin.mirror=false", "push", "--no-force", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `${snapshot.head}:refs/heads/fix/scoped`]);
  f.git("config", "remote.origin.vcs", "malicious"); await assert.rejects(inspectGit(f.cwd, request), /standard HTTPS/); f.git("config", "--unset", "remote.origin.vcs");
  f.git("config", "push.pushOption", "ci.skip"); await assert.rejects(inspectGit(f.cwd, request), /standard HTTPS/); f.git("config", "--unset", "push.pushOption");
  for (const url of ["/tmp/local-remote", "ssh://git@github.com/fixture/project.git", "https://user:password@github.com/fixture/project.git"]) {
    f.git("remote", "set-url", "origin", url); await assert.rejects(inspectGit(f.cwd, request));
  }
});

function broker(t, f, state = {}) {
  const handlers = new Map(), tools = new Map(), commands = new Map(); let prompts = 0, dispatches = 0;
  const ctx = { cwd: f.cwd, hasUI: true, ui: { select: async (_title, choices) => { if (choices.includes("Lire la page suivante")) return "Lire la page suivante"; prompts++; return state.choice ?? choices[3]; }, notify() {} } };
  const snapshot = { root: f.cwd, gitDir: join(f.cwd, ".git"), commonDir: join(f.cwd, ".git"), identity: "repo-id", stamp: "same", head: "a".repeat(40), branch: "main", staged: [], remoteUrl: "https://github.com/fixture/project.git" };
  registerGitAccess({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => ["git_access"] }, f.agent, () => {}, async (_program, args, options) => {
    assert.equal(options.cwd, ctx.cwd, "repository selection must not widen the sandbox workspace");
    const data = JSON.parse(options.input);
    if (data.action === "inspect") return JSON.stringify({ result: { ...snapshot, stamp: state.stamp ?? "same" } });
    assert.equal(args[0], "--write-roots"); dispatches++;
    return JSON.stringify({ result: { operation: data.request.operation, head: snapshot.head } });
  });
  t.after(() => handlers.get("session_shutdown")());
  return { ctx, snapshot, handlers, commands, get prompts() { return prompts; }, get dispatches() { return dispatches; }, request: input => tools.get("git_access").execute("test", { reason: "fixture", ...input }, undefined, undefined, ctx) };
}

test("a separate repository keeps the session cwd and its remembered consent can be revoked explicitly", async t => {
  const f = fixture(t), b = broker(t, f), source = join(f.base, "source");
  mkdirSync(source); b.ctx.cwd = source;
  const request = { repository: f.cwd, operation: "branch", branch: "develop" };
  await b.request(request); assert.equal(b.prompts, 1);
  await b.request(request); assert.equal(b.prompts, 1);
  await b.commands.get("git-access").handler(`permissions ${f.cwd}`, b.ctx);
  b.ctx.ui.select = async () => undefined;
  await assert.rejects(b.request(request), /not approved/);
});

test("project consent spans different local operations and restart, but push asks once every time and revocation removes the grant", async t => {
  const f = fixture(t), b = broker(t, f);
  assert.equal(CONFINED_TOOLS.has("git_access"), false);
  await b.request({ operation: "branch", branch: "fix/first" });
  await b.request({ operation: "stage", paths: ["file"] }); await b.request({ operation: "commit", paths: ["file"], message: "fix: fixture" });
  assert.equal(b.prompts, 1); assert.equal(b.dispatches, 3);
  await b.request({ operation: "stage", paths: Array.from({ length: 100 }, (_, i) => `explicit-file-${i}`) });
  assert.equal(b.prompts, 1, "remembered consent does not try to fit an unnecessary dialog");
  await b.handlers.get("session_start")(); await b.request({ operation: "stage", paths: ["other"] }); assert.equal(b.prompts, 1);
  const reopened = broker(t, f); await reopened.request({ operation: "branch", branch: "fix/new-session" }); assert.equal(reopened.prompts, 0);
  b.snapshot.identity = "replacement-repository";
  await b.request({ operation: "branch", branch: "fix/changed-repository" }); assert.equal(b.prompts, 2);
  let pushes = 0; b.ctx.ui.select = async (_title, choices) => { if (choices.includes("Lire la page suivante")) return "Lire la page suivante"; pushes++; assert.deepEqual(choices.filter(choice => choice !== "Relire la page précédente"), APPROVAL_CHOICES.slice(0, 2)); return choices[1]; };
  await b.request({ operation: "push", remote: "origin", branch: "fix/a" }); await b.request({ operation: "push", remote: "origin", branch: "fix/a" }); assert.equal(pushes, 2);
  await b.commands.get("git-access").handler("permissions", b.ctx);
  b.ctx.ui.select = async () => undefined;
  await assert.rejects(b.request({ operation: "stage", paths: ["file"] }), /not approved/);
});

test("headless, stale, refused and canceled approvals cannot dispatch", async t => {
  const f = fixture(t), state = {}, b = broker(t, f, state);
  b.ctx.hasUI = false; await assert.rejects(b.request({ operation: "branch", branch: "fix/a" }), /interactive parent/); b.ctx.hasUI = true;
  b.ctx.ui.select = async (_title, choices) => { if (choices.includes("Lire la page suivante")) return "Lire la page suivante"; state.stamp = "changed"; return APPROVAL_CHOICES[1]; };
  await assert.rejects(b.request({ operation: "branch", branch: "fix/a" }), /state changed/);
  // Closing an in-flight task must not be awaited from its own UI callback.
  b.ctx.ui.select = async () => { void b.handlers.get("session_start")(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(b.request({ operation: "branch", branch: "fix/a" }), /abort|cancel|stale/i);
  assert.equal(b.dispatches, 0);
});

test("linked worktrees bind their metadata and literal filenames never expand", async t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "literal*file"), "one\n"); writeFileSync(join(f.cwd, "literal-other-file"), "unrelated\n");
  await f.run({ operation: "stage", paths: ["literal*file"] }); await f.run({ operation: "commit", paths: ["literal*file"], message: "fix: fixture" });
  const linked = join(f.base, "linked"); f.git("worktree", "add", "-b", "fix/linked", linked);
  writeFileSync(join(linked, "literal*file"), "changed\n");
  const request = f.request({ operation: "stage", paths: ["literal*file"] }), snapshot = await inspectGit(linked, request);
  assert.equal(snapshot.root, linked); assert.equal(snapshot.commonDir, join(f.cwd, ".git")); assert.notEqual(snapshot.gitDir, snapshot.commonDir);
  assert.ok(gitWritePaths(snapshot, request).length <= 8);
  await performGit(linked, request, snapshot);
  const commit = f.request({ operation: "commit", paths: ["literal*file"], message: "fix: linked fixture" });
  await performGit(linked, commit, await inspectGit(linked, commit));
  assert.equal(f.git("diff", "--cached", "--name-only"), "", "other worktree index is untouched");
});

test("once/session consent, forged push grants, child use and paginated dialogs stay bounded", async t => {
  const f = fixture(t), state = { choice: APPROVAL_CHOICES[1] }, b = broker(t, f, state);
  await b.request({ operation: "branch", branch: "fix/one" }); await b.request({ operation: "branch", branch: "fix/two" }); assert.equal(b.prompts, 2);
  state.choice = APPROVAL_CHOICES[2]; await b.request({ operation: "stage", paths: ["one"] }); await b.request({ operation: "stage", paths: ["two"] }); assert.equal(b.prompts, 3);
  await b.handlers.get("session_start")(); await b.request({ operation: "stage", paths: ["three"] }); assert.equal(b.prompts, 4);
  state.choice = APPROVAL_CHOICES[3]; await assert.rejects(b.request({ operation: "push", remote: "origin", branch: "fix/a" }), /not approved/);
  await assert.rejects(b.request({ operation: "push", remote: "origin", branch: "fix/a", reason: "a different justification" }), /refused earlier/); assert.equal(b.prompts, 5);
  const old = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try { await assert.rejects(b.request({ operation: "stage", paths: ["three"] }), /interactive parent/); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = old; }
  await b.handlers.get("session_start")();
  let pages = 0;
  b.ctx.ui.select = async (_title, choices) => { pages++; return choices.includes("Lire la page suivante") ? "Lire la page suivante" : APPROVAL_CHOICES[1]; };
  await b.request({ operation: "branch", branch: "fix/long", reason: "界".repeat(490) });
  assert.ok(pages > 1, "the entire long payload is reviewed before approval");
});

test("160 explicit files can be committed without including another session's files", async t => {
  const f = fixture(t), paths = Array.from({ length: 160 }, (_, i) => `explicit-file-${i}`);
  for (const path of paths) writeFileSync(join(f.cwd, path), "fixture\n");
  writeFileSync(join(f.cwd, "unrelated"), "preserve\n");
  await f.run({ operation: "stage", paths });
  await f.run({ operation: "commit", paths, message: "fix: large explicit fixture" });
  assert.deepEqual(f.git("ls-tree", "--name-only", "HEAD").split("\n").sort(), paths.sort());
  assert.equal(readFileSync(join(f.cwd, "unrelated"), "utf8"), "preserve\n");
  assert.throws(() => f.request({ operation: "stage", paths: Array.from({ length: 1001 }, (_, i) => `file-${i}`) }), /1–1000/);
});

test("index-mutating pre-commit and commit-msg hooks refuse history changes, with effects left for inspection", async t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "file"), "one\n");
  for (const hook of ["pre-commit", "commit-msg"]) {
    await f.run({ operation: "stage", paths: ["file"] });
    writeFileSync(join(f.cwd, `.git/hooks/${hook}`), "#!/bin/sh\nprintf x >> file\nprintf unrelated > extra\ngit add -- file extra\n", { mode: 0o755 });
    await assert.rejects(f.run({ operation: "commit", paths: ["file"], message: "fix: hook fixture" }), /PI_GIT_GUARD_INDEX_CHANGED/);
    assert.equal(f.git("rev-parse", "--revs-only", "HEAD"), "");
    assert.equal(f.git("show", ":extra"), "unrelated");
    rmSync(join(f.cwd, `.git/hooks/${hook}`)); f.git("rm", "--cached", "--", "extra");
  }
});

test("canceling the fixed fixture worker reaches its Git/hook process group", { timeout: 15000 }, async t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "file"), "one\n"); await f.run({ operation: "stage", paths: ["file"] });
  writeFileSync(join(f.cwd, ".git/hooks/pre-commit"), "#!/bin/sh\ntrap 'printf terminated > terminated; exit 1' TERM\nprintf ready > ready\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  const request = f.request({ operation: "commit", paths: ["file"], message: "fix: canceled fixture" }), expected = await inspectGit(f.cwd, request);
  const controller = new AbortController(); t.after(() => controller.abort());
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture hook never became ready")), 8000);
    const path = join(f.cwd, "ready");
    watchFile(path, { persistent: false, interval: 20 }, () => { if (existsSync(path)) { clearTimeout(timer); unwatchFile(path); resolve(); } });
    t.after(() => { clearTimeout(timer); unwatchFile(path); });
  });
  const running = runProcess(process.execPath, [fileURLToPath(new URL("../scripts/git-operation.mjs", import.meta.url))], { cwd: f.cwd, input: JSON.stringify({ action: "execute", request, expected }), signal: controller.signal, timeoutMs: 12000 });
  const rejected = assert.rejects(running, /abort|cancel/i);
  await ready; controller.abort(); await rejected;
  assert.equal(readFileSync(join(f.cwd, "terminated"), "utf8"), "terminated"); assert.equal(f.git("rev-parse", "--revs-only", "HEAD"), "");
});

test("custom hook paths preserve message hooks, post hooks and reference-transaction stdin and vetoes", async t => {
  const f = fixture(t); mkdirSync(join(f.cwd, "hooks")); f.git("config", "core.hooksPath", "hooks");
  writeFileSync(join(f.cwd, "file"), "one\n"); await f.run({ operation: "stage", paths: ["file"] });
  writeFileSync(join(f.cwd, "hooks/prepare-commit-msg"), '#!/bin/sh\nprintf "prepared:%s\\n" "$2" >> order\n', { mode: 0o755 });
  writeFileSync(join(f.cwd, "hooks/commit-msg"), '#!/bin/sh\nprintf "\\nvalidated\\n" >> "$1"\nprintf "message\\n" >> order\n', { mode: 0o755 });
  writeFileSync(join(f.cwd, "hooks/post-commit"), '#!/bin/sh\nprintf "post\\n" >> order\n', { mode: 0o755 });
  writeFileSync(join(f.cwd, "hooks/post-index-change"), '#!/bin/sh\nprintf "index\\n" >> index-proof\n', { mode: 0o755 });
  writeFileSync(join(f.cwd, "hooks/reference-transaction"), '#!/bin/sh\ncat >> refs-proof\n[ "$1" != prepared ]\n', { mode: 0o755 });
  await assert.rejects(f.run({ operation: "commit", paths: ["file"], message: "fix: hooks" }));
  assert.equal(f.git("rev-parse", "--revs-only", "HEAD"), ""); assert.match(readFileSync(join(f.cwd, "refs-proof"), "utf8"), /refs\/heads\/main/);
  writeFileSync(join(f.cwd, "hooks/reference-transaction"), '#!/bin/sh\ncat >> refs-proof\n', { mode: 0o755 });
  await f.run({ operation: "commit", paths: ["file"], message: "fix: hooks" });
  assert.match(f.git("show", "-s", "--format=%B"), /validated/); assert.match(readFileSync(join(f.cwd, "order"), "utf8"), /prepared:message\nmessage\npost\n$/);
  assert.match(readFileSync(join(f.cwd, "index-proof"), "utf8"), /index/);
});
