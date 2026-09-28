import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { findPiPackageJson, EXPECTED_PACKAGE_NAME } from "./resolve-pi.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

test("PI_PACKAGE_JSON : accepté seulement si le nom du paquet correspond", async () => {
  const dir = await makeTmpDir("pi-agent-resolve-");
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  const malformed = join(dir, "malformed.json");
  await writeFile(good, JSON.stringify({ name: EXPECTED_PACKAGE_NAME, main: "./index.js" }));
  await writeFile(bad, JSON.stringify({ name: "npm:un-autre-paquet", main: "./index.js" }));
  await writeFile(malformed, "{ pas du json");
  try {
    assert.equal(findPiPackageJson({ PI_PACKAGE_JSON: good }), good);
    assert.equal(findPiPackageJson({ PI_PACKAGE_JSON: bad }), undefined, "nom de paquet non validé => refusé");
    assert.equal(findPiPackageJson({ PI_PACKAGE_JSON: malformed }), undefined, "JSON invalide => refusé, pas d'exception");
    assert.equal(findPiPackageJson({ PI_PACKAGE_JSON: join(dir, "absent.json") }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recherche sur PATH : ignore un exécutable dont le package.json le plus proche n'est pas Pi", async () => {
  const binDir = await makeTmpDir("pi-agent-resolve-bin-");
  const piPath = join(binDir, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n");
  await chmod(piPath, 0o755);
  await writeFile(join(binDir, "package.json"), JSON.stringify({ name: "npm:pas-pi" }));
  try {
    assert.equal(findPiPackageJson({ PATH: binDir }), undefined);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

test("recherche sur PATH : trouve le package.json Pi en remontant depuis le binaire", async () => {
  const root = await makeTmpDir("pi-agent-resolve-pkg-");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: EXPECTED_PACKAGE_NAME, main: "./index.js" }));
  const piPath = join(root, "bin", "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n");
  await chmod(piPath, 0o755);
  try {
    const realRoot = await realpath(root);
    assert.equal(findPiPackageJson({ PATH: join(root, "bin") }), join(realRoot, "package.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PATH vide ou pi absent : aucun package.json trouvé", async () => {
  assert.equal(findPiPackageJson({ PATH: "" }), undefined);
});
