import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findPiPackageJson } from "../lib/resolve-pi.mjs";

test("real Pi TUI resumes after Grob login, reconnect, menu cancellation and Ctrl+C", {
  skip: !["linux", "darwin"].includes(process.platform), timeout: 60000,
}, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-grob-terminal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = findPiPackageJson(), manifest = JSON.parse(readFileSync(pkg, "utf8"));
  const cli = join(dirname(pkg), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
  const log = join(root, "test.log"), fd = openSync(log, "w", 0o600);
  let result;
  try {
    result = spawnSync("python3", [
      fileURLToPath(new URL("./fixtures/grob-terminal.py", import.meta.url)), process.execPath, cli,
      fileURLToPath(new URL("../extensions/grob/command.ts", import.meta.url)), root,
    ], { stdio: ["ignore", fd, fd], timeout: 55000 });
  } finally { closeSync(fd); }
  const output = readFileSync(log, "utf8");
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /PASS: Pi menu, connect, reconnect, Ctrl\+C and return to prompt/);
});
