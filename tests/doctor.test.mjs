import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDoctor, REQUIRED_COMMANDS, OPTIONAL_COMMANDS, CONFINED_RUNTIME_FILES } from "../scripts/doctor.mjs";
import { makeFakeToolchain, makeTmpDir } from "./fixtures/build.mjs";

test("reports missing required tools and fails even without --strict", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  try {
    const result = await runDoctor({ target, env: { PATH: "" } });
    assert.equal(result.ok, false);
    const missingNames = result.missingRequired.map((r) => r.name);
    for (const cmd of REQUIRED_COMMANDS) assert.ok(missingNames.includes(cmd), `expected ${cmd} missing`);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("everything present (required + optional + bundled tool): ok even in --strict", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  await mkdir(join(target, "gates"), { recursive: true });
  await writeFile(join(target, "gates", "pi-prek"), "#!/bin/sh\nexit 0\n");
  await chmod(join(target, "gates", "pi-prek"), 0o755);
  try {
    const result = await runDoctor({ target, strict: true, env: { PATH: binDir } });
    assert.equal(result.missingRequired.length, 0);
    assert.equal(result.missingOptional.length, 0);
    assert.equal(result.ok, true);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("missing optional tool: ok by default, fails only in --strict", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  const present = [...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS.filter((c) => c !== "jj")];
  const binDir = await makeFakeToolchain(present);
  await mkdir(join(target, "gates"), { recursive: true });
  await writeFile(join(target, "gates", "pi-prek"), "#!/bin/sh\nexit 0\n");
  await chmod(join(target, "gates", "pi-prek"), 0o755);
  try {
    const lenient = await runDoctor({ target, strict: false, env: { PATH: binDir } });
    assert.equal(lenient.missingRequired.length, 0);
    assert.deepEqual(lenient.missingOptional.map((r) => r.name), ["jj"]);
    assert.equal(lenient.ok, true, "a missing optional tool does not fail the default mode");

    const strict = await runDoctor({ target, strict: true, env: { PATH: binDir } });
    assert.equal(strict.ok, false, "--strict mode fails when an optional tool is missing");
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("bundled tool gates/pi-prek missing: reported, optional", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  try {
    const result = await runDoctor({ target, env: { PATH: binDir } });
    const bundled = result.results.find((r) => r.name === "gates/pi-prek");
    assert.ok(bundled);
    assert.equal(bundled.ok, false);
    assert.equal(bundled.required, false);
    assert.equal(result.ok, true, "a missing bundled tool is not required outside --strict");
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("never reads or exposes the content of auth.json", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  await writeFile(join(target, "auth.json"), '{"secret":"never-display"}\n');
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  try {
    const result = await runDoctor({ target, env: { PATH: binDir } });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /never-display/);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("installed mode fails on stale executors, missing servers and unfiltered upstream LSP", async () => {
  const target = await makeTmpDir("pi-installed-doctor-");
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  const env = { PATH: binDir };
  try {
    assert.equal((await runDoctor({ target, installed: true, env })).ok, false);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/doctor.mjs", import.meta.url)), "--target", target, "--installed"], { env, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /extensions\/confined-lsp\/index\.ts: missing/);
    for (const file of CONFINED_RUNTIME_FILES) {
      await mkdir(dirname(join(target, file)), { recursive: true });
      await writeFile(join(target, file), await readFile(new URL(`../${file}`, import.meta.url)));
    }
    const settings = { shellPath: join(target, "scripts/codex-shell.mjs"), packages: [{ source: "npm:@ian-pascoe/pi-lsp@0.4.4", extensions: [] }] };
    await writeFile(join(target, "settings.json"), JSON.stringify(settings));
    for (const [name, version] of [["@ian-pascoe/pi-lsp", "0.4.4"], ["typescript", "7.0.2"]]) {
      const dir = join(target, "npm/node_modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
    }
    assert.equal((await runDoctor({ target, installed: true, env })).ok, true);
    await writeFile(join(target, "extensions/tool-policy/index.ts"), "// outdated policy\n");
    const stale = await runDoctor({ target, installed: true, env });
    assert.ok(stale.missingRequired.some(r => r.name === "extensions/tool-policy/index.ts"));
    settings.packages = ["npm:@ian-pascoe/pi-lsp@0.4.4"];
    await writeFile(join(target, "settings.json"), JSON.stringify(settings));
    assert.ok((await runDoctor({ target, installed: true, env })).missingRequired.some(r => r.name === "upstream LSP hooks filtered"));
  } finally { await rm(target, { recursive: true, force: true }); await rm(binDir, { recursive: true, force: true }); }
});

test("node:sqlite and the node version are checked", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  try {
    const result = await runDoctor({ target, env: { PATH: "" } });
    const sqlite = result.results.find((r) => r.name === "node:sqlite");
    assert.equal(sqlite.ok, true);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
