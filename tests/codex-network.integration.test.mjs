import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("real managed proxy permits only allowed hosts, blocks direct sockets, and keeps filesystem jail", { timeout: 90000, skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  // Must run on a host capable of creating Codex's OS sandbox, with public HTTPS access.
  const codex = realpathSync(process.env.PI_CODEX_SANDBOX_BIN ?? join(homedir(), ".local/bin/codex"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-network-integration-")));
  const agent = join(root, "agent"), cwd = join(root, "project"), home = join(root, "home");
  const server = createServer(socket => socket.destroy());
  try {
    for (const path of [join(agent, "scripts"), join(agent, "network-grants"), cwd, home, join(root, "outside")]) mkdirSync(path, { recursive: true });
    for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
    const launcher = join(agent, "scripts/codex-shell.mjs");
    chmodSync(launcher, 0o755);
    writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: ["registry.npmjs.org"] }));
    const env = { ...process.env, HOME: home, PI_CODEX_SANDBOX_BIN: codex };
    delete env.PI_CODEX_NETWORK_GRANTS;
    const run = command => {
      const result = spawnSync(launcher, ["-c", command], { cwd, env, encoding: "utf8", timeout: 20000 });
      assert.ifError(result.error);
      return result;
    };
    const fetch = host => `curl --noproxy '' --fail --silent --show-error --max-time 12 -o /dev/null -w '%{http_code}' https://${host}/`;
    const allowed = run(`printf inside > inside; if printf escape > ../outside/escape 2>/dev/null; then exit 91; fi; ${fetch("registry.npmjs.org")}`);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, "200");
    assert.equal(existsSync(join(root, "outside/escape")), false);
    const denied = run(fetch("example.com"));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /403|blocked/i, "unknown hosts must be rejected by the proxy, not simply fail DNS");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const direct = `const net=require('node:net');const s=net.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>process.exit(42));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(43),3000);`;
    assert.equal(run(`${quote(process.execPath)} -e ${quote(direct)}`).status, 0, "direct sockets must not reach even a live local server");
    const grant = join(agent, "network-grants/session.json");
    writeFileSync(grant, JSON.stringify({ cwd, hosts: ["example.com"] }), { mode: 0o600 });
    env.PI_CODEX_NETWORK_GRANTS = grant;
    const granted = run(fetch("example.com"));
    assert.equal(granted.status, 0, granted.stderr);
    assert.equal(granted.stdout, "200");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
