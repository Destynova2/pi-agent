import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-development-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, executable, args, env = process.env) {
  const log = join(root, "command.log"), fd = openSync(log, "w", 0o600);
  let result;
  try { result = spawnSync(executable, args, { env, cwd: root, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  assert.ifError(result.error);
  return { status: result.status, output: readFileSync(log, "utf8") };
}

test("semantic gate uses real SDK declarations and rejects API drift without emitting files", t => {
  const root = fixture(t), config = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  mkdirSync(join(root, "extensions"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: config, include: ["extensions/*.ts"], exclude: [] }));
  const source = join(root, "extensions/fixture.ts");
  const script = fileURLToPath(new URL("../scripts/typecheck.mjs", import.meta.url));
  const args = ["--input-type=module", "-e", `import { runTypecheck } from ${JSON.stringify(script)}; process.exitCode = runTypecheck({ root: process.cwd() });`];
  const valid = 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default function(pi: ExtensionAPI) { pi.on("session_shutdown", () => {}); }\n';
  writeFileSync(source, valid);
  const passed = run(root, process.execPath, args);
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /typecheck: TypeScript .*; Pi /);
  writeFileSync(source, valid.replace("session_shutdown", "session_event_that_does_not_exist"));
  const failed = run(root, process.execPath, args);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /error TS2769/);
  assert.deepEqual(readdirSync(join(root, "extensions")), ["fixture.ts"]);
  const missing = run(root, process.execPath, args, { ...process.env, PI_PACKAGE_JSON: join(root, "absent.json") });
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /Pi SDK not found/);
});

test("Python check rejects invalid syntax without executing sources or leaving bytecode", t => {
  const root = fixture(t), gates = join(root, "gates");
  mkdirSync(gates);
  const source = join(gates, "fixture.py");
  const args = [fileURLToPath(new URL("../scripts/check-python.py", import.meta.url)), root];
  writeFileSync(source, 'raise RuntimeError("must not execute")\n');
  const passed = run(root, "python3", args);
  assert.equal(passed.status, 0, passed.output);
  writeFileSync(source, "def broken(:\n");
  const failed = run(root, "python3", args);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /SyntaxError/);
  assert.deepEqual(readdirSync(gates), ["fixture.py"]);
});
