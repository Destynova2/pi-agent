import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
// A negative baseline, NOT qualification of GPU access. A future supported GPU
// capability must pass the same compute probe plus filesystem/network denials.
test("ordinary Codex Bash does not implicitly acquire Metal compute access", { skip: process.platform !== "darwin", timeout: 90000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-metal-baseline-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), home = join(root, "home");
  for (const path of [join(agent, "scripts"), cwd, home]) mkdirSync(path, { recursive: true });
  for (const file of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(agent, "scripts", file));
  copyFileSync(new URL("./fixtures/metal-probe.swift", import.meta.url), join(cwd, "probe.swift"));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex")) };
  const run = command => spawnSync(process.execPath, [join(agent, "scripts/codex-shell.mjs"), "--offline", "-c", command], { cwd, env, encoding: "utf8", timeout: 60000 });
  try {
    const compiled = run(`/usr/bin/swiftc -module-cache-path ${quote(join(cwd, "module-cache"))} probe.swift -o metal-probe`);
    assert.equal(compiled.status, 0, compiled.stderr);
    for (let i = 0; i < 2; i++) {
      const probe = run("./metal-probe");
      assert.equal(probe.status, 77, `${probe.error ?? ""}\n${probe.stdout}\n${probe.stderr}`);
      assert.match(probe.stdout, /METAL_UNAVAILABLE/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
