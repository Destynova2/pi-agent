import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cacheDirectory, command } from '../core.ts';
import registerExtension from '../index.ts';

// index.ts imports the bare specifier "typebox" as a value (not `import type`), so it must resolve
// at runtime. "typebox" is not a dependency of this test file or of the agent repo: it ships with
// the installed Pi package (@earendil-works/pi-coding-agent). This file does not generate any
// JavaScript source or register a `data:` URL module hook to redirect that specifier (a previous
// version did, and a security review rejected it for loading code from a runtime-built string).
// Resolution is instead the job of the static bootstrap module tests/resolve-pi.mjs, which uses
// node:module.registerHooks with a fixed, file-based (not string-generated) implementation. Run
// this suite as: node --import ../../../tests/resolve-pi.mjs --test extensions/graphify/tests/startup.test.mjs
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

for (const nested of [false, true]) {
  test(nested ? 'real startup: nested sub-repository, refusal = no graph' : 'real startup: simple repository indexed automatically', async (t) => {
    if (!requireDependency(t, 'git', gitFound)) return;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-auto-startup-')));
    const events = new Map();
    const notifications = [];
    let questions = 0;
    let finalStatus;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const previous = process.env.PI_GRAPHIFY_AUTO;
    delete process.env.PI_GRAPHIFY_AUTO;
    const ctx = { cwd: root, hasUI: true, ui: {
      select: async (title, options) => { questions++; notifications.push(title); return options[0]; },
      notify: (text) => notifications.push(text),
      setStatus: (_key, text) => { if (text !== 'AST indexing in background…') { finalStatus = text; finish(); } },
    } };
    let deadline;
    try {
      await command('git', ['init', '-q'], root);
      await writeFile(join(root, 'lib.rs'), 'pub fn automatic_fixture() -> usize { 42 }\n');
      if (nested) {
        await mkdir(join(root, 'child'));
        await command('git', ['init', '-q'], join(root, 'child'));
      }
      registerExtension({ on: (name, handler) => events.set(name, handler), registerTool: () => {}, registerCommand: () => {} });
      await events.get('session_start')({ reason: 'startup' }, ctx);
      await Promise.race([done, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(notifications.join('\n') || 'Indexing not finished')), 30000); })]);
      if (nested) {
        assert.equal(questions, 1);
        assert.match(notifications[0], /nested/);
        await assert.rejects(access(join(cacheDirectory(root), 'graphify-out/graph.json')));
      } else {
        assert.equal(questions, 0);
        assert.match(finalStatus, /Graphify ready/);
        await access(join(cacheDirectory(root), 'graphify-out/graph.json'));
      }
    } finally {
      clearTimeout(deadline);
      await events.get('session_shutdown')?.({}, ctx);
      if (previous === undefined) delete process.env.PI_GRAPHIFY_AUTO;
      else process.env.PI_GRAPHIFY_AUTO = previous;
      await rm(cacheDirectory(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}
