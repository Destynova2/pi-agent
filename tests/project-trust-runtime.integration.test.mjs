import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { findPiPackageJson } from "../lib/resolve-pi.mjs";
import { patchProjectTrust } from "../scripts/patch-project-trust.mjs";

const policy = fileURLToPath(new URL("../extensions/tool-policy/index.ts", import.meta.url));

test("real bundled CLI starts without --no-approve and never loads project code", { timeout: 90000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-trust-runtime-")));
  const installed = dirname(findPiPackageJson());
  const staged = join(root, "pi");
  const agent = join(root, "agent"), home = join(root, "home");
  try {
    await cp(installed, staged, { recursive: true });
    // Resolve the dependency tree instead of assuming a global npm layout;
    // PI_PACKAGE_JSON can point at an isolated runtime copy.
    const jiti = createRequire(join(installed, "package.json")).resolve("jiti/package.json");
    await symlink(dirname(dirname(jiti)), join(root, "node_modules"));
    await patchProjectTrust(staged);
    await mkdir(agent); await mkdir(home);
    await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "offline-fixture", defaultModel: "unused" }));
    const probe = join(root, "probe.ts");
    await writeFile(probe, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.registerProvider('offline-fixture', { api: 'offline-fixture', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'unused', name: 'unused', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() { throw new Error('No model calls allowed'); }
  });
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(process.env.PI_TRUST_PROOF, JSON.stringify({ trusted: ctx.isProjectTrusted(), argv: process.argv }));
    ctx.shutdown();
  });
}`);
    for (const resources of [false, true]) {
      const cwd = join(root, resources ? "project-resources" : "empty-project");
      const proof = join(root, resources ? "resources-proof.json" : "empty-proof.json");
      await mkdir(cwd);
      if (resources) {
        await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
        await writeFile(join(cwd, ".pi/extensions/untrusted.ts"), "throw new Error('UNTRUSTED_PROJECT_CODE_EXECUTED'); export default function() {}\n");
      }
      // Even an existing trusted entry must lose to the global confined-tool policy.
      await writeFile(join(agent, "trust.json"), JSON.stringify({ [cwd]: true }));
      const child = spawnSync(process.execPath, [join(staged, "dist/bundle/cli.js"), "--offline", "--mode", "rpc", "--no-session", "--extension", policy, "--extension", probe], {
        cwd, encoding: "utf8", input: "", timeout: 25000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_PACKAGE_JSON: join(staged, "package.json"), PI_TRUST_PROOF: proof },
      });
      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(child.stdout + child.stderr, /UNTRUSTED_PROJECT_CODE_EXECUTED|Failed to load extension/);
      const result = JSON.parse(await readFile(proof, "utf8"));
      assert.equal(result.trusted, false, `${resources ? "resource" : "empty"} project must start confined`);
      assert.ok(!result.argv.includes("--no-approve"), "no hidden CLI flag needed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
