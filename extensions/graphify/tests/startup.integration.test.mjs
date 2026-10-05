import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cacheDirectory, command } from '../core.ts';
import registerExtension from '../index.ts';

// Integration-only: extensions/graphify/index.ts dispatches every op (including the
// session_start automatic-index root/graph calls this file exercises) through
// lib/confined.ts's runConfined, which shells out to the real codex sandbox
// (scripts/codex-shell.mjs) with no in-process fallback. That needs a working,
// non-nested sandbox-exec and a codex binary (PI_CODEX_SANDBOX_BIN or ~/.local/bin/codex);
// inside another sandbox it fails with EPERM instead of indexing, which this suite would
// otherwise misread as "no repo found" for the 'simple'/'nested' cases. Run via
// `npm run test:integration`, not the default suite.

// index.ts imports the bare specifier "typebox" as a value (not `import type`), so it must resolve
// at runtime. "typebox" is not a dependency of this test file or of the agent repo: it ships with
// the installed Pi package (@earendil-works/pi-coding-agent). This file does not generate any
// JavaScript source or register a `data:` URL module hook to redirect that specifier (a previous
// version did, and a security review rejected it for loading code from a runtime-built string).
// Resolution is instead the job of the static bootstrap module tests/resolve-pi.mjs, which uses
// node:module.registerHooks with a fixed, file-based (not string-generated) implementation. Run
// this suite as: node --import ../../../tests/resolve-pi.mjs --test extensions/graphify/tests/startup.integration.test.mjs
// (or via the repo test runner, which wires that --import flag). Without that bootstrap in the
// process, the static `import registerExtension from '../index.ts'` above fails fast with a
// module-not-found error instead of silently skipping, because a required dependency of the code
// under test cannot resolve.

// Explicit skip only when the real dependency is absent; PI_TEST_INTEGRATION=1 forces a hard
// failure instead, so CI cannot silently pass without ever exercising this suite.
function requireDependency(t, label, found) {
	if (found) return true;
	if (process.env.PI_TEST_INTEGRATION === '1') throw new Error(`${label} missing: required by PI_TEST_INTEGRATION=1`);
	t.skip(`${label} missing: test explicitly skipped`);
	return false;
}

const gitFound = (process.env.PATH ?? '').split(delimiter).some((dir) => existsSync(join(dir, 'git')));
const graphifyFound = (process.env.PATH ?? '').split(delimiter).some((dir) => existsSync(join(dir, 'graphify')));

for (const mode of ['simple', 'nested', 'outside']) {
  const nested = mode !== 'simple';
  test(`startup/reload: ${mode} has no automatic root-selection prompt`, async (t) => {
    if (!requireDependency(t, 'git', gitFound)) return;
    if (mode !== 'outside' && !requireDependency(t, 'graphify', graphifyFound)) return;
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-auto-startup-')));
    const root = join(temp, 'project'), home = join(temp, 'home');
    await mkdir(root); await mkdir(home);
    const previousHome = process.env.HOME;
    const previousBackend = process.env.PI_CODEX_SANDBOX_BIN;
    process.env.PI_CODEX_SANDBOX_BIN = await realpath(previousBackend ?? join(homedir(), '.local/bin/codex'));
    process.env.HOME = home;
    const cache = cacheDirectory(root, join(home, '.cache/pi-codex-sandbox', createHash('sha256').update(root).digest('hex'), 'tmp/pi-graphify'));
    const graphPath = join(cache, 'graphify-out/graph.json');
    const events = new Map();
    const notifications = [];
    let questions = 0;
    let finalStatus;
    let finish;
    let graphifyCommand;
    const previous = process.env.PI_GRAPHIFY_AUTO;
    delete process.env.PI_GRAPHIFY_AUTO;
    const ctx = { cwd: root, hasUI: true, ui: {
      select: async (title, options) => { questions++; notifications.push(title); return options[0]; },
      notify: (text) => notifications.push(text),
      setStatus: (_key, text) => { if (text !== 'AST indexing in background…') { finalStatus = text; finish(); } },
    } };
    let deadline;
    try {
      if (mode !== 'outside') await command('git', ['init', '-q'], root);
      await writeFile(join(root, 'lib.rs'), 'pub fn automatic_fixture() -> usize { 42 }\n');
      if (nested) {
        await mkdir(join(root, 'child'));
        await command('git', ['init', '-q'], join(root, 'child'));
        await writeFile(join(root, 'child/lib.rs'), 'pub fn excluded_child_fixture() {}\n');
        await mkdir(join(root, '.claude/worktrees/agent/.git'), { recursive: true });
        await mkdir(join(root, ...Array.from({ length: 10 }, () => 'deep')), { recursive: true });
      }
      for (const reason of ['startup', 'reload']) {
        if (reason === 'reload') await events.get('session_shutdown')({}, ctx);
        const done = new Promise(resolve => { finish = resolve; });
        registerExtension({ on: (name, handler) => events.set(name, handler), registerTool: () => {}, registerCommand: (_name, command) => { graphifyCommand = command; } });
        await events.get('session_start')({ reason }, ctx);
        await Promise.race([done, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(notifications.join('\n') || 'Indexing not finished')), 30000); })]);
        clearTimeout(deadline);
        assert.equal(questions, 0);
        if (mode === 'outside') {
          assert.equal(finalStatus, undefined);
          await assert.rejects(access(graphPath));
        } else {
          assert.match(finalStatus, /Graphify ready/);
          await access(graphPath);
        }
      }
      if (mode === 'nested') {
        const before = await readFile(graphPath, 'utf8');
        assert.doesNotMatch(before, /excluded_child_fixture/);
        await graphifyCommand.handler('--include-nested', ctx);
        assert.equal(questions, 1);
        assert.match(notifications[0], /nested/);
        assert.equal(await readFile(graphPath, 'utf8'), before, 'refusal must not widen or replace the automatic graph');
      }
    } finally {
      clearTimeout(deadline);
      await events.get('session_shutdown')?.({}, ctx);
      if (previous === undefined) delete process.env.PI_GRAPHIFY_AUTO;
      else process.env.PI_GRAPHIFY_AUTO = previous;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousBackend === undefined) delete process.env.PI_CODEX_SANDBOX_BIN; else process.env.PI_CODEX_SANDBOX_BIN = previousBackend;
      await rm(temp, { recursive: true, force: true });
    }
  });
}
