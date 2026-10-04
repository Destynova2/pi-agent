#!/usr/bin/env node
// Operator-only qualification. Never installed or called by Pi's tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../lib/process.ts";
import { sandboxArgs } from "../../scripts/codex-shell.mjs";
import { networkSandboxArgs } from "../../scripts/codex-network.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export async function qualify(backend, output) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native Apple Silicon qualification required");
  if (existsSync(output)) throw new Error("Qualification output already exists");
  backend = realpathSync(backend);
  const root = realpathSync(mkdtempSync("/private/tmp/pi-metal-qualification-"));
  const cwd = join(root, "workspace"), scratch = join(root, "scratch"), config = join(root, "config");
  for (const dir of [cwd, scratch, config, join(cwd, ".git")]) mkdirSync(dir);
  const report = { schema: 1, qualified: false, backendSha256: digest(backend), platform: process.platform, arch: process.arch, osRelease: release(), at: new Date().toISOString(), checks: [] };
  const env = { ...process.env, CODEX_HOME: config, TMPDIR: scratch };
  delete env.BASH_ENV; delete env.ENV; delete env.PI_CODEX_NETWORK_GRANTS;
  const server = createServer(socket => {
    // The positive control deliberately closes immediately after connecting.
    socket.on("error", () => {});
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  });
  const stage = async (name, fn) => {
    try { const evidence = await fn(); report.checks.push({ name, pass: true, evidence }); console.log(`${name}: pass`); }
    catch (error) { report.checks.push({ name, pass: false, error: String(error.message).slice(-8000) }); throw error; }
  };
  const run = async (command, { metal = false, network = false, signal, timeoutMs = 15000, onStdout } = {}) => {
    assert.equal(digest(backend), report.backendSha256, "backend changed during qualification");
    const args = network ? networkSandboxArgs(command, cwd, scratch, ["github.com"]) : sandboxArgs(command);
    args.splice(1, 0, "--log-denials", ...(metal ? ["--allow-metal"] : []));
    let stdout = "", stderr = "", error;
    try {
      await runProcess(backend, args, { cwd, env, signal, timeoutMs, maxBytes: 1024 * 1024, graceMs: 100,
        onStdout: chunk => { stdout += chunk; onStdout?.(chunk); }, onStderr: chunk => { stderr += chunk; } });
    } catch (caught) { error = caught.message; }
    return { stdout, stderr, error };
  };
  const checkDenied = async () => {
    const result = await run("./metal-probe");
    assert.match(result.error ?? "", /code 77,/);
    assert.equal(result.stdout.trim(), "METAL_UNAVAILABLE");
    return result;
  };
  try {
    report.version = await runProcess(backend, ["--version"], { cwd, env, timeoutMs: 5000 });
    await stage("backend_option", async () => {
      const help = await runProcess(backend, ["sandbox", "--help"], { cwd, env, timeoutMs: 5000 });
      assert.match(help, /--allow-metal\b/, "backend has no explicit Metal capability");
      return "--allow-metal present; native checks still required";
    });
    copyFileSync(new URL("./metal-probe.swift", import.meta.url), join(cwd, "probe.swift"));
    await stage("compile_confined", async () => {
      const result = await run("/usr/bin/swiftc -module-cache-path ./module-cache probe.swift -o metal-probe", { timeoutMs: 60000 });
      assert.equal(result.error, undefined, JSON.stringify(result)); return result;
    });
    await stage("ordinary_before", checkDenied);
    await stage("metal_compute", async () => {
      const result = await run("./metal-probe", { metal: true });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.match(result.stdout, /METAL_COMPUTE_OK \[2\.0, 4\.0, 6\.0, 8\.0\]/); return result;
    });
    await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const port = server.address().port;
    await stage("network_control", () => new Promise((done, fail) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2000, () => socket.destroy(new Error("control timed out")));
      socket.once("error", fail); socket.once("connect", () => { socket.destroy(); done("host control connects to listening fixture"); });
    }));
    const outside = join(root, "outside"), metadata = join(cwd, ".git/config");
    for (const path of [outside, metadata]) writeFileSync(path, "unchanged");
    writeFileSync(join(cwd, "boundary.mjs"), `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs'; import {createConnection} from 'node:net';
writeFileSync('allowed','inside');
for(const path of ${JSON.stringify([outside, metadata])}) {
 assert.throws(()=>writeFileSync(path,'forbidden'),e=>['EPERM','EACCES'].includes(e.code));
}
await new Promise((resolve,reject)=>{
 const socket=createConnection({host:'127.0.0.1',port:${port}});
 socket.setTimeout(2000,()=>socket.destroy(new Error('timeout does not prove policy denial')));
 socket.once('connect',()=>{socket.destroy();reject(new Error('direct network allowed'));});
 socket.once('error',error=>['EPERM','EACCES'].includes(error.code)?resolve():reject(error));
}); console.log('FILE_NETWORK_DENIED');\n`);
    await stage("metal_file_network_boundary", async () => {
      const result = await run(`./metal-probe && ${quote(process.execPath)} boundary.mjs`, { metal: true });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.match(result.stdout, /FILE_NETWORK_DENIED/);
      for (const path of [outside, metadata]) assert.equal(readFileSync(path, "utf8"), "unchanged");
      assert.equal(readFileSync(join(cwd, "allowed"), "utf8"), "inside"); return result;
    });
    writeFileSync(join(cwd, "proxy.mjs"), `import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
const args=['--noproxy','','--fail','--silent','--show-error','--max-time','10','--output','/dev/null'];
const allowed=spawnSync('/usr/bin/curl',[...args,'https://github.com/robots.txt'],{encoding:'utf8',timeout:12000});
assert.equal(allowed.status,0,allowed.stderr);
const denied=spawnSync('/usr/bin/curl',[...args,'https://example.com/'],{encoding:'utf8',timeout:12000});
assert.notEqual(denied.status,0); assert.match(denied.stderr,/403/);
console.log('PROXY_ALLOWED_AND_DENIED');\n`);
    await stage("metal_managed_proxy_boundary", async () => {
      const result = await run(`./metal-probe && ${quote(process.execPath)} boundary.mjs && ${quote(process.execPath)} proxy.mjs`, {
        metal: true, network: true, timeoutMs: 30000,
      });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.match(result.stdout, /FILE_NETWORK_DENIED/); assert.match(result.stdout, /PROXY_ALLOWED_AND_DENIED/);
      for (const path of [outside, metadata]) assert.equal(readFileSync(path, "utf8"), "unchanged"); return result;
    });
    writeFileSync(join(cwd, "lifetime.mjs"), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn('/bin/sleep',['60'],{stdio:'ignore'});
writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));
console.log('LIFETIME_READY'); setInterval(()=>{},1000);\n`);
    for (const mode of ["cancel", "timeout"]) await stage(`metal_${mode}`, async () => {
      const abort = new AbortController(), pids = join(cwd, mode+".json");
      let ready = "";
      const result = await run(`./metal-probe && exec ${quote(process.execPath)} lifetime.mjs ${quote(pids)}`, {
        metal: true, signal: abort.signal, timeoutMs: mode === "timeout" ? 3000 : 10000,
        onStdout: chunk => { ready += chunk; if (mode === "cancel" && ready.includes("LIFETIME_READY")) abort.abort(); },
      });
      assert.match(ready, /LIFETIME_READY/);
      assert.match(result.error ?? "", mode === "cancel" ? /operation canceled/ : /deadline exceeded/);
      const ids = JSON.parse(readFileSync(pids, "utf8"));
      for (const pid of ids) {
        let gone = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { gone = true; break; } if (error.code !== "EPERM") throw error; }
          await new Promise(done => setTimeout(done, 20));
        }
        assert.equal(gone, true, "command or descendant survived supervision");
      }
      return { ...result, descendantsReaped: ids.length };
    });
    await stage("ordinary_after", checkDenied);
    report.qualified = true;
  } catch (error) { report.failure = String(error.message).slice(-8000); }
  finally {
    if (server.listening) await new Promise(done => server.close(done));
    // Reports remain valid after removing the disposable workspaces.
    try { writeFileSync(output, JSON.stringify(report, null, 2)+"\n", { flag: "wx", mode: 0o600 }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [backend, output, ...extra] = process.argv.slice(2);
  if (!backend || !output || extra.length) throw new Error("Usage: node experiments/metal/qualify.mjs /absolute/codex /new/report.json");
  const report = await qualify(backend, resolve(output));
  console.log(JSON.stringify({ qualified: report.qualified, checks: report.checks.map(({name,pass}) => ({name,pass})), output:resolve(output) }, null, 2));
  process.exitCode = report.qualified ? 0 : 1;
}
