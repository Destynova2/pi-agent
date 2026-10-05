#!/usr/bin/env node
// Operator-only native test of the real approval broker and launcher; no model calls.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCommandAccess } from "../../extensions/tool-policy/command-access.ts";
import { runProcess } from "../../lib/process.ts";
import { metalBackend } from "../../scripts/metal-backend.mjs";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function validatePi(backend, qualification, output) {
  if (existsSync(output)) throw new Error("Output already exists");
  const proof = JSON.parse(readFileSync(qualification, "utf8"));
  const root = realpathSync(mkdtempSync("/private/tmp/pi-metal-approval-"));
  const agent = join(root, "agent"), cwd = join(root, "workspace");
  for (const directory of [cwd, join(cwd, ".git"), join(agent, "scripts"), join(agent, "backends/metal")]) mkdirSync(directory, { recursive: true });
  for (const name of ["codex-shell.mjs", "codex-network.mjs", "metal-backend.mjs"]) copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(agent, "scripts", name));
  const launcher = join(agent, "scripts/codex-shell.mjs"); chmodSync(launcher, 0o700);
  copyFileSync(backend, join(agent, "backends/metal/codex")); chmodSync(join(agent, "backends/metal/codex"), 0o700);
  copyFileSync(qualification, join(agent, "backends/metal/qualification.json")); chmodSync(join(agent, "backends/metal/qualification.json"), 0o600);
  writeFileSync(join(agent, "metal-backend.json"), JSON.stringify({ schema: 1, sha256: proof.backendSha256 }), { mode: 0o600 });
  writeFileSync(join(agent, "network-policy.json"), JSON.stringify({ allow: [] }));
  copyFileSync(new URL("./metal-probe.swift", import.meta.url), join(cwd, "probe.swift"));
  const handlers = new Map(), journal = [], prompts = [];
  let tool;
  const ctx = { cwd, hasUI: true, ui: { confirm: async (title, text) => { prompts.push({ title, text }); return true; } } };
  registerCommandAccess({ on: (name, handler) => handlers.set(name, handler), registerTool: value => { tool = value; }, appendEntry: (type, data) => journal.push({ type, ...data }), getActiveTools: () => ["request_command_access"] }, agent, () => {});
  const report = { schema: 1, passed: false, backendSha256: proof.backendSha256, checks: [] };
  const run = async command => {
    let stdout = "";
    try {
      await runProcess(launcher, ["-c", command], { cwd, timeoutMs: 60000, maxBytes: 1024 * 1024, onStdout: chunk => { stdout += chunk; } });
      return stdout;
    } catch (error) { throw new Error(`${error.message}\n${stdout}`); }
  };
  const capture = async (id, command) => {
    const event = { toolName: "bash", toolCallId: id, input: { command } };
    handlers.get("tool_call")(event, ctx);
    await assert.rejects(run(command), /METAL_UNAVAILABLE/);
    handlers.get("tool_result")({ ...event, content: [], isError: true }, ctx);
  };
  const request = id => tool.execute("approval", { failed_call_id: id, gpu: "metal", reason: "native qualification" }, undefined, undefined, ctx);
  try {
    metalBackend(agent);
    await handlers.get("session_start")({}, ctx);
    await run("/usr/bin/swiftc -module-cache-path ./module-cache probe.swift -o metal-probe");
    const outside = join(root, "outside"); writeFileSync(outside, "unchanged");
    writeFileSync(join(cwd, "boundary.mjs"), `import assert from 'node:assert/strict'; import fs from 'node:fs';
for (const path of ${JSON.stringify([outside, join(cwd, ".git/config"), join(agent, "metal-backend.json")])}) {
 assert.throws(()=>fs.writeFileSync(path,'bad'),error=>['EPERM','EACCES'].includes(error.code));
} console.log('PI_FILES_DENIED');\n`);
    const command = `./metal-probe && ${quote(process.execPath)} boundary.mjs`;
    await capture("compute", command);
    const result = await request("compute");
    assert.match(result.content[0].text, /METAL_COMPUTE_OK/); assert.match(result.content[0].text, /PI_FILES_DENIED/);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
    assert.equal(prompts.length, 1); assert.ok(prompts[0].text.includes(proof.backendSha256));
    assert.ok(prompts[0].text.includes(JSON.stringify(command)));
    assert.deepEqual(journal.map(entry => entry.status), ["started", "completed"]);
    assert.equal(journal[1].command, command); assert.match(journal[1].output, /METAL_COMPUTE_OK/);
    await assert.rejects(request("compute"), /No eligible/);
    await assert.rejects(run("./metal-probe"), /METAL_UNAVAILABLE/);
    await assert.rejects(run(`${quote(launcher)} --metal ${quote(proof.backendSha256)} -c './metal-probe'`), error => {
      assert.doesNotMatch(error.message, /METAL_COMPUTE_OK/);
      assert.match(error.message, /sandbox_apply|Operation not permitted|METAL_UNAVAILABLE/);
      return true;
    });
    report.checks.push("exact_approval", "metal_compute", "file_boundaries", "result_journal", "one_shot", "ordinary_gpu_denied", "nested_upgrade_denied");

    // Session navigation must reap both the approved command and its descendant.
    writeFileSync(join(cwd, "wait.mjs"), `import {spawn} from 'node:child_process'; import fs from 'node:fs';
const child=spawn('/bin/sleep',['60'],{stdio:'ignore'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);\n`);
    await capture("cancel", `./metal-probe && exec ${quote(process.execPath)} wait.mjs`);
    const stopped = assert.rejects(request("cancel"), /canceled/);
    for (let i = 0; i < 1000 && !existsSync(join(cwd, "pids.json")); i++) await new Promise(done => setTimeout(done, 10));
    assert.ok(existsSync(join(cwd, "pids.json")), "approved command started");
    const pids = JSON.parse(readFileSync(join(cwd, "pids.json"), "utf8"));
    await handlers.get("session_before_switch")(); await stopped;
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(journal.at(-1).status, "canceled");
    report.checks.push("session_cancel", "descendants_reaped", "cancellation_journal");
    report.passed = true;
  } catch (error) { report.failure = String(error.stack).slice(-8000); }
  finally {
    await handlers.get("session_shutdown")();
    try { writeFileSync(output, JSON.stringify(report, null, 2)+"\n", { flag: "wx", mode: 0o600 }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [backend, qualification, output, ...extra] = process.argv.slice(2);
  if (!backend || !qualification || !output || extra.length) throw new Error("Usage: node --import ./tests/resolve-pi.mjs experiments/metal/validate-pi.mjs /absolute/codex /qualification.json /new/pi-report.json");
  const report = await validatePi(backend, qualification, resolve(output));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
