import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeGitInitStage, createGitInitStage, initializeGit, inspectGitInitTarget, publishGitInit, validateGitInit } from "../lib/git-init.ts";
import { gitOperationArgs, inspectGit, performGit, validateGitRequest } from "../extensions/tool-policy/git-access-core.ts";
import { registerGitInit } from "../extensions/tool-policy/git-init.ts";
import { APPROVAL_CHOICES } from "../lib/mcp-approvals.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-init-test-")));
  const repository = join(root, "repository"), home = join(root, "home"), agent = join(root, "agent"), cwd = join(root, "source");
  for (const path of [repository, home, agent, cwd]) mkdirSync(path);
  const previous = Object.fromEntries(["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TEMPLATE_DIR", "PI_SUBAGENT_CHILD"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  delete process.env.GIT_TEMPLATE_DIR; delete process.env.PI_SUBAGENT_CHILD;
  const request = validateGitInit({ repository, branch: "main", remote: "origin", url: "https://example.com/team/project.git", author_name: "Fixture", author_email: "fixture@example.com", message: "chore: initialize repository", reason: "initialize a separate repository" });
  const stage = createGitInitStage();
  t.after(() => {
    closeGitInitStage(stage); rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { root, repository, cwd, home, agent, request, stage, git };
}

test("initialization grammar accepts only an explicit destination, identity and credential-free HTTPS remote", t => {
  const f = fixture(t);
  for (const change of [
    { repository: "/" }, { repository: "relative" }, { repository: `${f.root}/../other` },
    { branch: "--orphan" }, { branch: "a..b" }, { branch: "a/.hidden" }, { branch: "a.lock" },
    { url: "https://token@example.com/project" }, { url: "file:///repo" }, { url: "ssh://example.com/repo" },
    { url: "https://example.com/repo?token=secret" }, { remote: "--mirror" },
    { author_email: "name\n[alias]" }, { author_name: "someone <other@example.com>" }, { noVerify: true },
  ]) assert.throws(() => validateGitInit({ ...f.request, ...change }));
  assert.equal(CONFINED_TOOLS.has("git_repository_init"), false, "initialization is never delegated");
  for (const request of [
    { operation: "stage", paths: ["file"], source_branch: "main" },
    { operation: "push", branch: "main", remote: "origin", source_branch: "HEAD~1" },
    { operation: "push", branch: "main", remote: "origin", repository: "../repository" },
  ]) assert.throws(() => validateGitRequest({ ...request, reason: "fixture" }));
});

test("new root stays empty and source files stay untracked, then develop can carry content without old history", async t => {
  const f = fixture(t), identity = inspectGitInitTarget(f.repository);
  writeFileSync(join(f.repository, "file"), "reviewed content\n");
  writeFileSync(join(f.cwd, "source-file"), "preserved\n");
  const initialized = await initializeGit(f.stage, f.request);
  assert.equal(existsSync(join(f.repository, ".git")), false, "preparation cannot publish metadata");
  const result = publishGitInit(f.stage, f.request, identity, initialized);
  assert.equal(f.git("rev-list", "--parents", "HEAD"), result.head);
  assert.equal(f.git("ls-tree", "-r", "HEAD"), "");
  assert.equal(f.git("status", "--porcelain"), "?? file");
  assert.equal(f.git("remote", "get-url", "origin"), f.request.url);
  assert.equal(f.git("config", "--local", "user.email"), f.request.author_email);
  assert.equal(existsSync(join(f.home, ".gitconfig")), false);
  assert.equal(readFileSync(join(f.cwd, "source-file"), "utf8"), "preserved\n");
  const run = async input => {
    const request = validateGitRequest({ repository: f.repository, reason: "fixture", ...input });
    return performGit(f.repository, request, await inspectGit(f.repository, request));
  };
  await run({ operation: "branch", branch: "develop" });
  await run({ operation: "stage", paths: ["file"] });
  await run({ operation: "commit", paths: ["file"], message: "feat: add developer portal" });
  assert.equal(f.git("rev-parse", "develop^"), result.head);
  assert.equal(f.git("ls-tree", "-r", "main"), "");
  const push = validateGitRequest({ repository: f.repository, operation: "push", source_branch: "main", branch: "main", remote: "origin", reason: "publish reviewed root" });
  const snapshot = await inspectGit(f.repository, push);
  assert.notEqual(snapshot.head, result.head);
  assert.equal(snapshot.pushHead, result.head);
  assert.equal(gitOperationArgs(push, snapshot).at(-1), `${result.head}:refs/heads/main`);
  const changed = { ...push, source_branch: "develop" };
  assert.notEqual((await inspectGit(f.repository, changed)).stamp, snapshot.stamp, "the approved source commit belongs to the request");
  await assert.rejects(inspectGit(f.repository, { ...push, repository: f.cwd }), /exact canonical worktree root/);
});

test("existing repositories, dangling metadata links and linked destination parents are refused", t => {
  const f = fixture(t);
  for (const marker of [".git", ".jj"]) {
    const path = join(f.repository, marker);
    symlinkSync(join(f.root, "missing"), path);
    assert.throws(() => inspectGitInitTarget(f.repository), /already has repository/);
    rmSync(path);
  }
  const linked = join(f.root, "linked"); symlinkSync(f.repository, linked);
  assert.throws(() => inspectGitInitTarget(linked), /canonical directory/);
  mkdirSync(join(f.repository, ".git"));
  assert.throws(() => inspectGitInitTarget(f.repository), /already has repository/);
});

test("scratch accepts only empty sandbox placeholders, never existing files or linked metadata", async t => {
  const f = fixture(t);
  mkdirSync(join(f.stage.metadata, ".git"));
  writeFileSync(join(f.stage.metadata, ".git/HEAD"), "existing");
  await assert.rejects(initializeGit(f.stage, f.request), /fresh private scratch/);
  rmSync(join(f.stage.metadata, ".git"), { recursive: true });
  symlinkSync(f.cwd, join(f.stage.worktree, ".agents"));
  await assert.rejects(initializeGit(f.stage, f.request), /fresh private scratch/);
  rmSync(join(f.stage.worktree, ".agents"));
  writeFileSync(join(f.stage.worktree, "file"), "existing");
  await assert.rejects(initializeGit(f.stage, f.request), /fresh private scratch/);
});

test("template hooks and signing remain effective and cannot silently change the root tree", async t => {
  for (const kind of ["failure", "stage", "config", "signing"]) await t.test(kind, async child => {
    const f = fixture(child), template = join(f.root, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    process.env.GIT_TEMPLATE_DIR = template;
    if (kind === "signing") {
      const config = join(f.home, "signing-config");
      writeFileSync(config, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n");
      process.env.GIT_CONFIG_GLOBAL = config;
    } else {
      const body = kind === "failure" ? "exit 19" : kind === "stage" ? "echo injected > injected; git add injected" : "git config --local alias.injected '!bad'";
      writeFileSync(join(template, "hooks/pre-commit"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    await assert.rejects(initializeGit(f.stage, f.request));
    assert.equal(existsSync(join(f.repository, ".git")), false);
  });
});

test("metadata changes and concurrent repository creation stop publication without replacing anything", async t => {
  for (const kind of ["metadata", "destination", "link", "object"]) await t.test(kind, async child => {
    const f = fixture(child), identity = inspectGitInitTarget(f.repository), result = await initializeGit(f.stage, f.request);
    if (kind === "metadata") writeFileSync(join(f.stage.metadata, "config"), "changed\n");
    if (kind === "destination") mkdirSync(join(f.repository, ".git"));
    if (kind === "link") { rmSync(join(f.stage.metadata, "config")); symlinkSync(join(f.root, "missing"), join(f.stage.metadata, "config")); }
    if (kind === "object") {
      const object = join(f.stage.metadata, "objects", result.head.slice(0, 2), result.head.slice(2));
      rmSync(object); writeFileSync(object, "invalid object");
    }
    assert.throws(() => publishGitInit(f.stage, f.request, identity, result));
    assert.equal(existsSync(join(f.repository, ".git/HEAD")), false);
  });
});

test("initialization requires exact consent and cancels on refusal, session navigation or changed destination", async t => {
  const f = fixture(t), handlers = new Map(), commands = new Map(); let tool, calls = 0;
  registerGitInit({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), registerTool: value => { tool = value; }, getActiveTools: () => ["git_repository_init"] }, f.agent, () => {}, async (_launcher, args, options) => {
    calls++;
    assert.ok(args.includes("--offline"));
    assert.notEqual(options.cwd, f.repository);
    const stage = { worktree: options.cwd, root: join(options.cwd, ".."), metadata: JSON.parse(args[1])[0] };
    return JSON.stringify({ result: await initializeGit(stage, JSON.parse(options.input), options.signal) });
  });
  const ctx = { cwd: f.cwd, hasUI: true, ui: { select: async () => APPROVAL_CHOICES[0], notify() {} } };
  const execute = () => tool.execute("fixture", f.request, undefined, undefined, ctx);
  await assert.rejects(execute(), /not approved/); assert.equal(calls, 0);
  await handlers.get("session_start")();
  ctx.hasUI = false;
  await assert.rejects(execute(), /interactive parent/); assert.equal(calls, 0);
  ctx.hasUI = true;
  let closing;
  ctx.ui.select = async () => { closing = handlers.get("session_before_switch")(); return APPROVAL_CHOICES[1]; };
  await assert.rejects(execute()); await closing; assert.equal(calls, 0);
  ctx.ui.select = async () => { mkdirSync(join(f.repository, ".git")); return APPROVAL_CHOICES[1]; };
  await assert.rejects(execute()); assert.equal(calls, 0);
  rmSync(join(f.repository, ".git"), { recursive: true });
  await commands.get("git-init").handler("reset", ctx);
  let reviewed = "";
  ctx.ui.select = async (title, choices) => {
    reviewed += title;
    return choices.includes("Lire la page suivante") ? "Lire la page suivante" : APPROVAL_CHOICES[1];
  };
  await execute(); assert.equal(calls, 1);
  assert.match(reviewed.replaceAll("\n", " "), /chore: initialize repository/);
  assert.equal(f.git("ls-tree", "-r", "HEAD"), "");
  await handlers.get("session_shutdown")();
});
