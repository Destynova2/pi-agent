import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from '/Users/ludwig/.bun/install/global/node_modules/jiti/lib/jiti.mjs';
import { cacheDirectory, command } from '../core.ts';

const jiti = createJiti(import.meta.url, { alias: { typebox: join(homedir(), '.bun/install/global/node_modules/typebox/build/index.mjs') } });
const register = await jiti.import('../index.ts', { default: true });

for (const nested of [false, true]) {
  test(nested ? 'startup réel : sous-dépôt annoncé, refus = aucun graphe' : 'startup réel : dépôt simple indexé automatiquement', async () => {
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
      setStatus: (_key, text) => { if (text !== 'Indexation AST en arrière-plan…') { finalStatus = text; finish(); } },
    } };
    let deadline;
    try {
      await command('git', ['init', '-q'], root);
      await writeFile(join(root, 'lib.rs'), 'pub fn automatic_fixture() -> usize { 42 }\n');
      if (nested) {
        await mkdir(join(root, 'child'));
        await command('git', ['init', '-q'], join(root, 'child'));
      }
      register({ on: (name, handler) => events.set(name, handler), registerTool: () => {}, registerCommand: () => {} });
      await events.get('session_start')({ reason: 'startup' }, ctx);
      await Promise.race([done, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(notifications.join('\n') || 'Indexation non terminée')), 30000); })]);
      if (nested) {
        assert.equal(questions, 1);
        assert.match(notifications[0], /imbriqué/);
        await assert.rejects(access(join(cacheDirectory(root), 'graphify-out/graph.json')));
      } else {
        assert.equal(questions, 0);
        assert.match(finalStatus, /Graphify prêt/);
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
