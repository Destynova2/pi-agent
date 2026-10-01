import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfined } from "../lib/confined.ts";

test("CI helper queries run inside Codex and cancellation stops the nested helper", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ci-jail-")));
  const cwd = join(root, "project"); mkdirSync(cwd);
  const outside = join(root, "outside"), pidFile = join(cwd, "pid");
  writeFileSync(outside, "unchanged");
  const previous = { PATH: process.env.PATH, CI_FIXTURE_HANG: process.env.CI_FIXTURE_HANG };
  const controller = new AbortController(); let pending;
  try {
    writeFileSync(join(root, "gh"), `#!${process.execPath}
const fs = require('node:fs');
let denied = false;
try { fs.writeFileSync(${JSON.stringify(outside)}, 'bad'); } catch (error) { denied = ['EPERM','EACCES','EROFS'].includes(error.code); }
fs.writeFileSync('proof', JSON.stringify({denied, sandbox: process.env.CODEX_SANDBOX}));
if (process.env.CI_FIXTURE_HANG === '1') {
  process.on('SIGTERM', ()=>{}); fs.writeFileSync('pid', String(process.pid)); setInterval(()=>{}, 1000);
} else console.log(JSON.stringify({number: 7}));
`, { mode: 0o700 });
    process.env.PATH = `${root}:${previous.PATH}`;
    assert.deepEqual(await runConfined(cwd, "ci", { op: "current", cwd: root, provider: "github" }), { op: "current", number: 7 });
    const proof = JSON.parse(readFileSync(join(cwd, "proof"), "utf8"));
    assert.ok(proof.sandbox); assert.equal(proof.denied, true);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
    process.env.CI_FIXTURE_HANG = "1";
    pending = runConfined(cwd, "ci", { op: "current", provider: "github" }, controller.signal).then(result => ({ result }), error => ({ error }));
    for (let attempt = 0; attempt < 250 && !existsSync(pidFile); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "helper must have started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    assert.match(String((await pending).error), /canceled/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort(); await pending;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
