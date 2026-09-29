import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { buildArgs, gitInspect, MAX_OUTPUT_BYTES } from "../index.ts";

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-git-inspect-"));
  const repo = join(root, "repo");
  const sentinels = join(root, "sentinels");
  mkdirSync(join(repo, "sub"), { recursive: true });
  mkdirSync(sentinels);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "sub", "b.txt"), "bee\n");
  writeFileSync(join(repo, ".gitattributes"), "*.txt diff=evil filter=evil\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  // Hand-made signed commit so log.showSignature would call gpg.program.
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const parent = git("rev-parse", "HEAD").trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned commit\n`;
  const signed = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, env: ENV, input: body, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  git("update-ref", "HEAD", signed);
  const helper = join(root, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\ntouch "${sentinels}/$1"\ncat\n`);
  const gpg = join(root, "gpg.sh"); // gpg.program is exec'd directly, without a shell
  writeFileSync(gpg, `#!/bin/sh\ntouch "${sentinels}/gpg"\nexit 1\n`);
  chmodSync(helper, 0o755);
  chmodSync(gpg, 0o755);
  for (const [key, name] of [
    ["diff.external", "external"], ["diff.evil.command", "diffcommand"], ["diff.evil.textconv", "textconv"],
    ["core.fsmonitor", "fsmonitor"], ["core.pager", "pager"], ["pager.diff", "pagerdiff"], ["pager.log", "pagerlog"],
    ["pager.status", "pagerstatus"], ["filter.evil.clean", "clean"], ["filter.evil.smudge", "smudge"],
  ]) git("config", key, `${helper} ${name}`);
  git("config", "gpg.program", gpg);
  git("config", "log.showSignature", "true");
  git("config", "filter.evil.required", "true");
  git("config", "color.ui", "always");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "sub", "b.txt"), "bee\nstaged\n");
  git("add", "sub/b.txt");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  return { root, repo, sentinels, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("malicious repo helpers run under plain git (control) but never under git_inspect", async () => {
  const f = fixture();
  try {
    f.git("-c", "core.pager=cat", "log", "-n", "1");
    f.git("diff");
    f.git("diff", "--no-ext-diff"); // textconv
    f.git("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "diff"); // diff.external without the driver
    const fired = readdirSync(f.sentinels);
    for (const name of ["diffcommand", "external", "fsmonitor", "clean", "textconv", "gpg"]) assert.ok(fired.includes(name), `control sentinel ${name} missing: ${fired}`);
    rmSync(f.sentinels, { recursive: true });
    mkdirSync(f.sentinels);
    for (const input of [{ operation: "status" }, { operation: "diff" }, { operation: "diff", staged: true }, { operation: "log" }, { operation: "files" }] as const) {
      const out = await gitInspect(f.repo, input);
      assert.doesNotMatch(out, /\x1b\[/, "no color escapes");
    }
    assert.deepEqual(readdirSync(f.sentinels), []);
  } finally { f.cleanup(); }
});

test("missing promisor objects never trigger a remote helper or lazy network fetch", async () => {
  const f = fixture();
  const oldPath = process.env.PATH;
  try {
    const bin = join(f.root, "bin"); mkdirSync(bin);
    const marker = join(f.sentinels, "remote-fetch");
    writeFileSync(join(bin, "git-remote-pitest"), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(1);\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath}`;
    const missing = f.git("rev-parse", "HEAD:a.txt").trim();
    f.git("config", "core.repositoryformatversion", "1");
    f.git("config", "extensions.partialClone", "origin");
    f.git("config", "remote.origin.promisor", "true");
    f.git("config", "remote.origin.url", "pitest::unreachable");
    f.git("config", "protocol.pitest.allow", "always");
    rmSync(join(f.repo, ".git/objects", missing.slice(0, 2), missing.slice(2)));
    assert.throws(() => execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv"], {
      cwd: f.repo, env: { ...ENV, PATH: process.env.PATH, GIT_NO_LAZY_FETCH: "0" }, stdio: "ignore", timeout: 5000,
    }));
    assert.ok(existsSync(marker), "negative control must invoke the promisor remote");
    rmSync(marker);
    await assert.rejects(gitInspect(f.repo, { operation: "diff" }), /failed/);
    assert.equal(existsSync(marker), false, "read-only inspection must not invoke a remote");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    f.cleanup();
  }
});

test("fixed operations report status, diffs, log and files", async () => {
  const f = fixture();
  try {
    const status = await gitInspect(f.repo, { operation: "status" });
    assert.match(status, / M a\.txt/);
    assert.match(status, /M  sub\/b\.txt/);
    assert.match(status, /\?\? new\.txt/);
    const diff = await gitInspect(f.repo, { operation: "diff" });
    assert.match(diff, /\+two/);
    assert.doesNotMatch(diff, /\+staged/);
    const staged = await gitInspect(f.repo, { operation: "diff", staged: true });
    assert.match(staged, /\+staged/);
    assert.doesNotMatch(staged, /\+two/);
    assert.match(await gitInspect(f.repo, { operation: "log" }), /signed commit\n[0-9a-f]+ initial/);
    assert.deepEqual((await gitInspect(f.repo, { operation: "files" })).split("\n").sort(), [".gitattributes", "a.txt", "new.txt", "sub/b.txt"]);
  } finally { f.cleanup(); }
});

test("path filters are literal and scoped after --", async () => {
  const f = fixture();
  try {
    assert.equal(await gitInspect(f.repo, { operation: "files", paths: ["sub"] }), "sub/b.txt");
    assert.equal(await gitInspect(f.repo, { operation: "diff", paths: ["sub"] }), "(no output)");
    assert.equal(await gitInspect(f.repo, { operation: "diff", paths: ["*.txt"] }), "(no output)", "no glob magic");
    const out = join(f.root, "written");
    assert.equal(await gitInspect(f.repo, { operation: "diff", paths: [`--output=${out}`] }), "(no output)");
    assert.equal(existsSync(out), false, "option-looking path is not an option");
    assert.deepEqual(buildArgs({ operation: "files", paths: ["-x"] }).slice(-2), ["--", "-x"]);
  } finally { f.cleanup(); }
});

test("invalid inputs are rejected before git runs", () => {
  const bad: any[] = [
    { operation: "diff", paths: ["../x"] }, { operation: "diff", paths: ["a/../../b"] }, { operation: "files", paths: ["..\\x"] },
    { operation: "files", paths: ["/etc/passwd"] }, { operation: "files", paths: ["C:/x"] }, { operation: "files", paths: ["a\0b"] },
    { operation: "files", paths: [""] }, { operation: "files", paths: Array(101).fill("a") }, { operation: "files", paths: "a" },
    { operation: "status", paths: ["a"] }, { operation: "log", paths: ["a"] }, { operation: "files", staged: true },
    { operation: "log", staged: false }, { operation: "diff", staged: "yes" }, { operation: "push" }, { operation: "--exec=x" },
  ];
  for (const input of bad) assert.throws(() => buildArgs(input), undefined, JSON.stringify(input));
});

test("output is bounded to 16 KiB on a UTF-8 boundary with a narrowing notice", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "big.txt"), "é".repeat(30_000) + "\n");
    f.git("add", "big.txt");
    const big = await gitInspect(f.repo, { operation: "diff", staged: true, paths: ["big.txt"] });
    const [body, notice] = big.split("\n[output truncated");
    assert.ok(notice, "truncation notice present");
    assert.match(notice, /narrow the request with paths/);
    assert.ok(Buffer.byteLength(body) <= MAX_OUTPUT_BYTES);
    assert.doesNotMatch(body, /\uFFFD/);
  } finally { f.cleanup(); }
});

test("registered tool uses ctx.cwd, propagates git errors and aborts", async () => {
  const f = fixture();
  try {
    let tool: any;
    extension({ registerTool: (t: any) => { tool = t; } } as any);
    assert.equal(tool.name, "git_inspect");
    assert.deepEqual(tool.parameters.properties.operation.anyOf.map((s: any) => s.const), ["status", "diff", "log", "files"]);
    const result = await tool.execute("id", { operation: "files", paths: ["sub"] }, undefined, undefined, { cwd: f.repo });
    assert.equal(result.content[0].text, "sub/b.txt");
    await assert.rejects(tool.execute("id", { operation: "status" }, undefined, undefined, { cwd: f.root }), /git_inspect status failed|not a git repository/);
    await assert.rejects(tool.execute("id", { operation: "status" }, AbortSignal.abort(), undefined, { cwd: f.repo }), /cancel/);
  } finally { f.cleanup(); }
});
