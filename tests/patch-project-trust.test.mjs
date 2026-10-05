import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { findPiPackageJson } from "../lib/resolve-pi.mjs";
import { patchProjectTrust, transformTrust, TRUST_TARGETS_BY_VERSION } from "../scripts/patch-project-trust.mjs";

const manifest = findPiPackageJson();
assert.ok(manifest, "Installed Pi is required for pinned runtime regression tests");
const { version } = JSON.parse(await readFile(manifest, "utf8"));
const TRUST_TARGETS = TRUST_TARGETS_BY_VERSION[version];
assert.ok(TRUST_TARGETS, `Unsupported runtime for trust regressions: ${version}`);

async function originals() {
  return Promise.all(TRUST_TARGETS.map(async target => {
    const source = await readFile(join(dirname(manifest), target.path), "utf8");
    return createHash("sha256").update(source).digest("hex") === target.sha256 ? source : transformTrust(source, target, true);
  }));
}

test("SDK and bundle honor personal trust decisions even without project resources", async () => {
  const sources = await originals();
  for (const [index, target] of TRUST_TARGETS.entries()) {
    const original = sources[index];
    const patched = transformTrust(original, target);
    assert.equal(transformTrust(patched, target, true), original);
    if (index === 2) {
      assert.ok(!patched.includes("cachedProjectTrust === undefined && hasTrustRequiringResources"));
      continue;
    }
    const extract = source => {
      const start = source.indexOf("async function resolveProjectTrusted(");
      const end = index === 0 ? source.indexOf("//# sourceMappingURL", start) : source.indexOf("function collectSettingsDiagnostics", start);
      assert.ok(start >= 0 && end > start);
      return source.slice(start, end);
    };
    let resources = false, calls = 0, decision = { trusted: "no" };
    const globals = {
      hasTrustRequiringProjectResources: () => resources,
      emitProjectTrustEvent: async () => { calls++; return { result: decision, errors: [] }; },
    };
    const options = { cwd: "/fixture", extensionsResult: {}, projectTrustContext: { hasUI: false }, trustStore: { get: () => true } };
    assert.equal(await runInNewContext(`${extract(original)}\nresolveProjectTrusted`, globals)(options), true, "reproduces empty-directory bypass");
    assert.equal(calls, 0);
    const resolveTrust = runInNewContext(`${extract(patched)}\nresolveProjectTrusted`, globals);
    assert.equal(await resolveTrust(options), false, target.path);
    assert.equal(calls, 1);
    resources = true;
    assert.equal(await resolveTrust(options), false, "personal denial beats remembered trust");
    assert.equal(await resolveTrust({ ...options, trustOverride: true }), true, "native explicit override unchanged; broker still rejects trusted execution");
    assert.equal(await resolveTrust({ ...options, trustOverride: false }), false);
    decision = undefined;
    resources = false;
    assert.equal(await resolveTrust(options), true, "no decision preserves native empty-project behavior");
    resources = true;
    assert.equal(await resolveTrust(options), true, "saved trust still applies when no extension decides");
  }
});

test("pinned patch validates every artifact before writing and is exactly idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-trust-patch-"));
  const sources = await originals();
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
    for (const [index, target] of TRUST_TARGETS.entries()) {
      await mkdir(dirname(join(root, target.path)), { recursive: true });
      await writeFile(join(root, target.path), sources[index]);
    }
    const second = join(root, TRUST_TARGETS[1].path);
    await writeFile(second, "unexpected input");
    await assert.rejects(patchProjectTrust(root), /Unknown trust patch/);
    assert.equal(await readFile(join(root, TRUST_TARGETS[0].path), "utf8"), sources[0]);
    await writeFile(second, sources[1]);
    assert.equal((await patchProjectTrust(root)).patched.length, TRUST_TARGETS.length);
    assert.equal((await patchProjectTrust(root)).alreadyPatched, TRUST_TARGETS.length);
    await writeFile(second, `${await readFile(second, "utf8")}\n// modified after patch\n`);
    await assert.rejects(patchProjectTrust(root), /Unknown trust patch/);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
    await assert.rejects(patchProjectTrust(root), /unknown versions refused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
