// Qualifies the native proxy exception without contacting a real repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../lib/process.ts";
import { sandboxBackend } from "../scripts/codex-shell.mjs";

test("private Git proxy reaches only its named destination; direct sockets, other hosts and ordinary commands remain blocked", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-private-")));
  const agent = join(root, "agent"), cwd = join(root, "repo"), home = join(root, "home");
  const host = "localhost.localdomain";
  const server = createServer((_req, res) => { res.writeHead(200); res.end("private-fixture"); });
  const codex = realpathSync(sandboxBackend());
  try {
    // A private DNS name is essential: an IP literal has different Codex semantics.
    const addresses = await lookup(host, { all: true });
    assert.ok(addresses.length && addresses.every(({ address }) => address === "127.0.0.1" || address === "::1"), "native fixture requires localhost.localdomain resolving to loopback");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, resolve); });
    const port = server.address().port;
    for (const path of [join(agent, "scripts"), cwd, home, join(cwd, ".git")]) mkdirSync(path, { recursive: true });
    for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
    writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: [host, "github.com"] }));
    const worker = join(agent, "scripts/git-operation.mjs");
    // This trusted fixture occupies the exact fixed-worker path. No configurable
    // command is accepted by the production launcher, even with this capability.
    writeFileSync(worker, `import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import net from 'node:net'; import fs from 'node:fs';
const curl = host => spawnSync('curl', ['--noproxy','','--silent','--show-error','--max-time','5','--fail', 'http://'+host+':${port}/'], {encoding:'utf8'});
const allowed = curl(${JSON.stringify(host)});
if (process.env.PI_GIT_PRIVATE_NETWORK !== 'true') { assert.notEqual(allowed.status,0); assert.match(allowed.stderr,/403/); console.log('private-blocked'); }
else {
  assert.equal(allowed.status,0,allowed.stderr); assert.equal(allowed.stdout,'private-fixture');
  for (const host of ['127.0.0.1','github.com','example.com']) { const denied=curl(host); assert.notEqual(denied.status,0); assert.match(denied.stderr,/403/); }
  assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(root, "outside"))},'escape'),/EPERM|EACCES|EROFS/);
  await new Promise((resolve,reject)=>{ const s=net.connect(${port},'127.0.0.1'); s.on('connect',()=>{s.destroy();reject(new Error('direct socket escaped'));}); s.on('error',resolve); s.setTimeout(3000,()=>{s.destroy();reject(new Error('direct probe timed out'));}); });
  console.log('private-scoped');
}
`);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, worker].map(quote).join(" ");
    const launcher = join(agent, "scripts/codex-shell.mjs");
    const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODEX_SANDBOX_BIN: codex, PI_CODEX_NETWORK_GRANTS: undefined };
    const run = args => runProcess(process.execPath, [launcher, ...args], { cwd, env, timeoutMs: 15000 });
    const args = privateNetwork => ["--git-network", JSON.stringify({ host, privateNetwork }), "--write-roots", JSON.stringify([join(cwd, ".git")]), "-c", command];
    assert.equal(await run(args(false)), "private-blocked");
    assert.equal(await run(args(true)), "private-scoped");
    assert.equal(await run(["-c", command]), "private-blocked", "the private exception never survives into ordinary commands");
    writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: [host], deny: [host] }));
    await assert.rejects(run(args(true)), /NETWORK_DENIED/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
