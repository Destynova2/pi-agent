// Offline fixtures only: stubs `git`/`gh`/`glab` on PATH, no network, no paid provider calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCi, overallOf, type Snapshot } from "../extensions/ci-watch/worker.ts";
import { finiteRange, formatSnapshot, transition, validatePr } from "../extensions/ci-watch/index.ts";

/** Writes an executable stub on PATH that prints `script` body's result as stdout. */
async function stub(dir: string, name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), `#!${process.execPath}\nconst argv = process.argv.slice(2);\n${body}\n`, { mode: 0o700 });
}

async function withBin(fixtures: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ci-watch-"));
  const oldPath = process.env.PATH;
  try {
    for (const [name, body] of Object.entries(fixtures)) await stub(dir, name, body);
    process.env.PATH = `${dir}:${oldPath}`;
    await run(dir);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
}

test("detect: github/gitlab origin recognised, anything else rejected", async () => {
  await withBin({ git: `console.log(argv.join(" ") === "remote get-url origin" ? "git@github.com:acme/repo.git" : "");` }, async (dir) => {
    assert.deepEqual(await executeCi({ op: "detect", cwd: dir }), { op: "detect", provider: "github" });
  });
  await withBin({ git: `console.log("https://gitlab.example.com/acme/repo.git");` }, async (dir) => {
    assert.deepEqual(await executeCi({ op: "detect", cwd: dir }), { op: "detect", provider: "gitlab" });
  });
  await withBin({ git: `console.log("https://bitbucket.org/acme/repo.git");` }, async (dir) => {
    await assert.rejects(executeCi({ op: "detect", cwd: dir }), /not recognised/);
  });
});

test("current: reads the branch's PR/MR number from gh/glab", async () => {
  await withBin({ gh: `console.log(JSON.stringify({ number: 42 }));` }, async (dir) => {
    assert.deepEqual(await executeCi({ op: "current", cwd: dir, provider: "github" }), { op: "current", number: 42 });
  });
  await withBin({ glab: `console.log(JSON.stringify({ iid: 7 }));` }, async (dir) => {
    assert.deepEqual(await executeCi({ op: "current", cwd: dir, provider: "gitlab" }), { op: "current", number: 7 });
  });
});

test("snapshot: github checks roll up to overall pending/success/failure", async () => {
  const d = {
    number: 1, title: "t", url: "https://github.com/a/b/pull/1", state: "OPEN",
    mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "abcdef0123",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS" },
    ],
  };
  await withBin({ gh: `console.log(JSON.stringify(${JSON.stringify(d)}));` }, async (dir) => {
    const result = await executeCi({ op: "snapshot", cwd: dir, provider: "github", number: 1 });
    assert.equal(result.op, "snapshot");
    const snap = (result as { snapshot: Snapshot }).snapshot;
    assert.equal(snap.overall, "pending");
    assert.equal(snap.conflict, false);
    assert.equal(snap.review, "APPROVED");
  });
  const failing = { ...d, statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }] };
  await withBin({ gh: `console.log(JSON.stringify(${JSON.stringify(failing)}));` }, async (dir) => {
    const result = await executeCi({ op: "snapshot", cwd: dir, provider: "github", number: 1 });
    assert.equal((result as { snapshot: Snapshot }).snapshot.overall, "failure");
  });
});

test("snapshot: gitlab pipeline + conflict mapping", async () => {
  const d = {
    state: "opened", web_url: "https://gitlab.example.com/a/b/-/merge_requests/3", title: "mr",
    sha: "deadbeef00", has_conflicts: true,
    head_pipeline: { id: 9, status: "failed", web_url: "https://gitlab.example.com/a/b/-/pipelines/9" },
  };
  await withBin({ glab: `if (argv[0] === "api") console.log(JSON.stringify({ approved: false })); else console.log(JSON.stringify(${JSON.stringify(d)}));` }, async (dir) => {
    const result = await executeCi({ op: "snapshot", cwd: dir, provider: "gitlab", number: 3 });
    const snap = (result as { snapshot: Snapshot }).snapshot;
    assert.equal(snap.overall, "failure");
    assert.equal(snap.conflict, true);
    assert.equal(snap.checks[0].state, "failure");
  });
});

test("log: fetches the failing job's tail for a red github check", async () => {
  const snap: Snapshot = {
    provider: "github", number: 1, title: "t", url: "u", state: "open", review: "none", conflict: false,
    head: "abc", overall: "failure",
    checks: [{ name: "build", state: "failure", url: "https://github.com/a/b/actions/runs/123" }],
  };
  await withBin({ gh: `console.log("boom at line 1");` }, async (dir) => {
    const result = await executeCi({ op: "log", cwd: dir, snapshot: snap });
    assert.match((result as { text: string }).text, /boom at line 1/);
  });
});

test("worker validates finite ranges: rejects non-positive/non-integer PR numbers and bad providers", async () => {
  await assert.rejects(executeCi({ op: "snapshot", cwd: "/tmp", provider: "github", number: 0 }), /invalid PR\/MR number/);
  await assert.rejects(executeCi({ op: "snapshot", cwd: "/tmp", provider: "github", number: 1.5 }), /invalid PR\/MR number/);
  await assert.rejects(executeCi({ op: "snapshot", cwd: "/tmp", provider: "github", number: -1 }), /invalid PR\/MR number/);
  await assert.rejects(executeCi({ op: "snapshot", cwd: "/tmp", provider: "bitbucket" as never, number: 1 }), /invalid provider/);
});

test("overallOf: empty/skipped-only is none, any pending without failure is pending", () => {
  assert.equal(overallOf([]), "none");
  assert.equal(overallOf([{ name: "a", state: "skipped" }]), "none");
  assert.equal(overallOf([{ name: "a", state: "pending" }, { name: "b", state: "success" }]), "pending");
  assert.equal(overallOf([{ name: "a", state: "success" }]), "success");
});

test("index: finiteRange/validatePr enforce bounded, finite, positive input", () => {
  assert.equal(finiteRange("x", undefined, 1, 10), undefined);
  assert.equal(finiteRange("x", 5, 1, 10), 5);
  assert.throws(() => finiteRange("x", Number.NaN, 1, 10), /finite/);
  assert.throws(() => finiteRange("x", Number.POSITIVE_INFINITY, 1, 10), /finite/);
  assert.throws(() => finiteRange("x", 0, 1, 10), /between/);
  assert.throws(() => finiteRange("x", 11, 1, 10), /between/);
  assert.equal(validatePr(undefined), undefined);
  assert.equal(validatePr(42), 42);
  assert.throws(() => validatePr(0), /positive integer/);
  assert.throws(() => validatePr(1.5), /positive integer/);
  assert.throws(() => validatePr(Number.NaN), /positive integer/);
});

test("index: transition reports only the events worth a wake-up", () => {
  const base: Snapshot = { provider: "github", number: 1, title: "t", url: "u", state: "open", review: "none", conflict: false, head: "a", overall: "pending", checks: [] };
  assert.equal(transition(undefined, base), undefined);
  assert.equal(transition(base, { ...base }), undefined);
  assert.equal(transition(base, { ...base, state: "merged" }), "merged");
  assert.equal(transition({ ...base, state: "merged" }, { ...base, state: "merged" }), undefined);
  assert.equal(transition(base, { ...base, conflict: true }), "merge conflict");
  assert.match(transition(base, { ...base, review: "approved" }) ?? "", /review: approved/);
  assert.match(transition(base, { ...base, head: "b" }) ?? "", /new commits pushed/);
  assert.match(transition(base, { ...base, overall: "success" }) ?? "", /checks green/);
  assert.match(transition({ ...base, overall: "failure" }, { ...base, overall: "failure", head: "b" }) ?? "", /checks red/);
});

test("index: formatSnapshot includes identifying fields and per-check lines", () => {
  const snap: Snapshot = {
    provider: "gitlab", number: 3, title: "fix", url: "https://x", state: "open", review: "approved",
    conflict: true, head: "0123456789", overall: "failure", checks: [{ name: "build", state: "failure", url: "https://x/log" }],
  };
  const text = formatSnapshot(snap);
  assert.match(text, /MR #3 fix/);
  assert.match(text, /CONFLICT/);
  assert.match(text, /build: failure https:\/\/x\/log/);
});
