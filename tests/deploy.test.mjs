import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/deploy.sh", import.meta.url));
test("deployment rejects invalid SDK paths before staging or running gates", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-deploy-sdk-"));
  try {
    const bin = join(root, "bin"), target = join(root, "live"), log = join(root, "commands");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    for (const name of ["npm", "pi", "codex", "git", "curl", "python3"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\nexit 37\n', { mode: 0o755 });
    }
    const manifest = join(root, "sdk with spaces.json");
    const malformed = join(root, "malformed.json"), unrelated = join(root, "unrelated.json");
    writeFileSync(manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    writeFileSync(malformed, "{");
    writeFileSync(unrelated, JSON.stringify({ name: "unrelated" }));
    const run = path => {
      const stdout = join(root, "stdout.log"), stderr = join(root, "stderr.log");
      const out = openSync(stdout, "w"), err = openSync(stderr, "w");
      let result;
      try {
        result = spawnSync("bash", [script], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
            PI_PACKAGE_JSON: path, PI_CODING_AGENT_DIR: target, COMMAND_LOG: log },
          stdio: ["ignore", out, err], timeout: 10000,
        });
      } finally { closeSync(out); closeSync(err); }
      assert.ifError(result.error);
      return { ...result, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
    };
    for (const [path, message] of [
      [join(root, "nod \n e_modules/package.json"), /contains a line break/],
      [`${manifest}\r`, /contains a line break/],
      [join(root, "missing.json"), /Cannot read PI_PACKAGE_JSON=.*ENOENT/],
      [root, /Cannot read PI_PACKAGE_JSON=.*EISDIR/],
      [malformed, /valid JSON manifest/],
      [unrelated, /installed @earendil-works\/pi-coding-agent\/package.json/],
    ]) {
      const result = run(path);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /node:fs|at ModuleJob/);
      assert.doesNotMatch(result.stdout, /Staging and logs/);
      assert.equal(existsSync(log), false, "no gate or installer may run");
      assert.equal(existsSync(target), false);
    }
    const valid = run(manifest);
    assert.equal(valid.status, 37, valid.stderr);
    assert.match(readFileSync(log, "utf8"), /^run check -- --evidence .*\/check.json\n$/, "a valid path with spaces reaches the first gate");
    assert.equal(existsSync(target), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deployment gates precede confirmation and live writes; failures preserve exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-deploy-test-"));
  try {
    const bin = join(root, "bin"), log = join(root, "commands");
    mkdirSync(bin);
    for (const name of ["node", "npm", "pi", "codex", "git", "curl", "python3"]) {
      writeFileSync(join(bin, name), `#!/bin/bash
command="\${0##*/} $*"
printf '%s\\n' "$command" >> "$COMMAND_LOG"
if [[ -n "$FAIL_COMMAND" && "$command" == *"$FAIL_COMMAND"* ]]; then exit 37; fi
`, { mode: 0o755 });
    }
    const target = join(root, "live");
    const run = (fail, input = "DEPLOY\n") => {
      writeFileSync(log, "");
      const inputPath = join(root, "input"), outputPath = join(root, "output"), errorPath = join(root, "error");
      writeFileSync(inputPath, input);
      const descriptors = [openSync(inputPath, "r"), openSync(outputPath, "w"), openSync(errorPath, "w")];
      let result;
      try {
        result = spawnSync("bash", [script], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
            PI_PACKAGE_JSON: join(root, "sdk.json"), PI_CODING_AGENT_DIR: target,
            COMMAND_LOG: log, FAIL_COMMAND: fail },
          stdio: descriptors,
        });
      } finally { descriptors.forEach(closeSync); }
      assert.ifError(result.error);
      return { ...result, stdout: readFileSync(outputPath, "utf8"), stderr: readFileSync(errorPath, "utf8"), commands: readFileSync(log, "utf8") };
    };
    for (const fail of ["npm run check", "node scripts/install.mjs", "node scripts/doctor.mjs", "npm run verify:integration"]) {
      const result = run(fail);
      assert.equal(result.status, 37, result.stderr);
      assert.ok(!result.commands.includes(`--target ${target}`), result.commands);
    }
    const cancelled = run("", "no\n");
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.ok(!cancelled.commands.includes(`--target ${target}`));
    const success = run("");
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.commands.includes("npm install"), false, "deployment must not download a separate patch-test SDK");
    assert.ok(success.commands.indexOf("npm run verify:integration") < success.commands.indexOf(`--target ${target}`));
    assert.ok(success.commands.includes(`node scripts/doctor.mjs --target ${target} --installed`));
    const failedInstall = run(`node scripts/install.mjs --target ${target}`);
    assert.equal(failedInstall.status, 37);
    assert.ok(!failedInstall.commands.includes(`node scripts/doctor.mjs --target ${target}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
