import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfined } from "../lib/confined.ts";

test("web_search executes its Claude helper inside Codex with private runtime state (no provider call)", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-search-jail-")));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const outside = join(root, "outside");
  writeFileSync(outside, "unchanged");
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(root, "claude"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
let denied = false;
try { writeFileSync(${JSON.stringify(outside)}, 'bad'); } catch (error) { denied = ['EPERM','EACCES','EROFS'].includes(error.code); }
console.log(JSON.stringify({ denied, sandbox: process.env.CODEX_SANDBOX, home: process.env.HOME, tmp: process.env.TMPDIR, args: process.argv.slice(2) }));
`, { mode: 0o700 });
    process.env.PATH = `${root}:${oldPath}`;
    const result = JSON.parse(await runConfined(cwd, "search", { query: "offline fixture" }));
    assert.equal(result.denied, true);
    assert.ok(result.sandbox);
    assert.ok(result.home.startsWith(result.tmp));
    assert.ok(result.args.includes("--safe-mode"));
    assert.ok(result.args.includes("--strict-mcp-config"));
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
