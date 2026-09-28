import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDoctor, REQUIRED_COMMANDS, OPTIONAL_COMMANDS } from "../scripts/doctor.mjs";
import { makeFakeToolchain, makeTmpDir } from "./fixtures/build.mjs";

test("signale les outils requis manquants et échoue même sans --strict", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  try {
    const result = await runDoctor({ target, env: { PATH: "" } });
    assert.equal(result.ok, false);
    const missingNames = result.missingRequired.map((r) => r.name);
    for (const cmd of REQUIRED_COMMANDS) assert.ok(missingNames.includes(cmd), `${cmd} attendu manquant`);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("tout présent (requis + optionnel + outil embarqué) : ok même en --strict", async () => {
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

test("outil optionnel manquant : ok par défaut, échec seulement en --strict", async () => {
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
    assert.equal(lenient.ok, true, "outil optionnel manquant ne fait pas échouer le mode par défaut");

    const strict = await runDoctor({ target, strict: true, env: { PATH: binDir } });
    assert.equal(strict.ok, false, "le mode --strict échoue si un outil optionnel manque");
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("outil embarqué gates/pi-prek absent : signalé, optionnel", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  try {
    const result = await runDoctor({ target, env: { PATH: binDir } });
    const bundled = result.results.find((r) => r.name === "gates/pi-prek");
    assert.ok(bundled);
    assert.equal(bundled.ok, false);
    assert.equal(bundled.required, false);
    assert.equal(result.ok, true, "outil embarqué manquant n'est pas requis hors --strict");
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("ne lit ni n'expose le contenu de auth.json", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  await writeFile(join(target, "auth.json"), '{"secret":"ne-jamais-afficher"}\n');
  const binDir = await makeFakeToolchain([...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]);
  try {
    const result = await runDoctor({ target, env: { PATH: binDir } });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /ne-jamais-afficher/);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("node:sqlite et la version de node sont vérifiés", async () => {
  const target = await makeTmpDir("pi-agent-doctor-target-");
  try {
    const result = await runDoctor({ target, env: { PATH: "" } });
    const sqlite = result.results.find((r) => r.name === "node:sqlite");
    assert.equal(sqlite.ok, true);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
