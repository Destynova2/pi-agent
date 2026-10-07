import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runVerification } from "../scripts/verify.mjs";

test("verification records commands, tests, failure status, signals and source identity without caching tests", async t => {
  const parent = await mkdtemp(join(tmpdir(), "pi-verify-fixture-")), root = join(parent, "source");
  await mkdir(join(root, "scripts"), { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: parent };
  await writeFile(join(root, "unit.test.mjs"), "// selection fixture\n");
  await writeFile(join(root, "host.integration.test.mjs"), "// selection fixture\n");
  const check = join(root, "scripts/check.mjs"), tests = join(root, "scripts/test.mjs");
  await writeFile(check, "console.log('checked');\n");
  await writeFile(tests, "console.log('tested', process.argv.slice(2));\n");
  const success = await runVerification({ root, env });
  assert.equal(success.exitCode, 0);
  assert.equal(success.report.selectedTests.length, 1);
  assert.deepEqual(success.report.phases.map(p => p.status), ["passed", "passed"]);
  const full = await runVerification({ root, env, integration: true, reuseCheck: join(parent, "old-check.json") });
  assert.equal(full.report.selectedTests.length, 2);
  assert.ok(full.report.phases[0].command.includes("--reuse-evidence"));
  assert.match(await readFile(full.report.phases[1].log, "utf8"), /tested.*--integration/);
  assert.notEqual(success.reportPath, full.reportPath);
  for (const [source, status, signal] of [
    ["console.error('assertion failed'); process.exitCode = 37;\n", 37, null],
    ["process.kill(process.pid, 'SIGTERM');\n", 1, "SIGTERM"],
    ["console.error('test: Pi SDK not found. No tests executed.'); process.exitCode = 1;\n", 1, null],
  ]) {
    await writeFile(tests, source);
    const failed = await runVerification({ root, env });
    assert.equal(failed.exitCode, status);
    const stored = JSON.parse(await readFile(failed.reportPath, "utf8"));
    assert.equal(stored.status, "failed");
    assert.equal(stored.phases[1].signal, signal);
    assert.equal(stored.phases[1].status, "failed");
    assert.equal(Boolean(stored.phases[1].prerequisiteFailure), source.includes("SDK not found"));
  }
  await writeFile(tests, "import { writeFileSync } from 'node:fs'; writeFileSync('changed.ts', '// changed\\n');\n");
  const changed = await runVerification({ root, env });
  assert.equal(changed.exitCode, 1);
  assert.match(changed.report.error, /Inputs changed/);
  await writeFile(check, "process.exitCode = 29;\n");
  const stopped = await runVerification({ root, env });
  assert.equal(stopped.exitCode, 29);
  assert.deepEqual(stopped.report.phases.map(p => p.name), ["check"], "failed check must stop the gate before tests");
});
