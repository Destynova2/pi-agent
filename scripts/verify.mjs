#!/usr/bin/env node
// Every invocation runs tests. Only an unchanged successful syntax check can be reused.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTests } from "./test.mjs";
import { validationInputs } from "./validation-inputs.mjs";

export async function runVerification({ root = fileURLToPath(new URL("..", import.meta.url)), integration = false, reuseCheck, env = process.env } = {}) {
  root = resolve(root);
  const directory = mkdtempSync(join(env.TMPDIR || tmpdir(), "pi-verify-"));
  const reportPath = join(directory, "result.json");
  const report = { version: 1, status: "running", root, integration, startedAt: new Date().toISOString(), phases: [] };
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  save();
  console.log(`verify: report and command logs: ${reportPath}`);
  let exitCode = 1;
  try {
    report.inputs = validationInputs(root, env);
    report.selectedTests = collectTests(root, { all: integration });
    const checkArgs = [join(root, "scripts/check.mjs"), "--evidence", join(directory, "check.json")];
    if (reuseCheck) checkArgs.push("--reuse-evidence", resolve(reuseCheck));
    const phases = [
      ["check", checkArgs],
      ["test", [join(root, "scripts/test.mjs"), ...(integration ? ["--integration"] : [])]],
    ];
    exitCode = 0;
    for (const [name, args] of phases) {
      const phase = { name, command: [process.execPath, ...args], cwd: root, status: "running", log: join(directory, `${name}.log`) };
      report.phases.push(phase);
      save();
      console.log(`verify: ${name}: ${phase.log}`);
      const fd = openSync(phase.log, "wx", 0o600);
      const start = performance.now();
      let interrupted;
      let child;
      const forward = signal => { interrupted = signal; child?.kill(signal); };
      const onInt = () => forward("SIGINT"), onTerm = () => forward("SIGTERM");
      process.once("SIGINT", onInt);
      process.once("SIGTERM", onTerm);
      try {
        const result = await new Promise(resolveResult => {
          child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", fd, fd] });
          child.once("error", error => resolveResult({ exitCode: null, signal: null, error: { code: error.code, message: error.message } }));
          child.once("exit", (code, signal) => resolveResult({ exitCode: code, signal }));
        });
        Object.assign(phase, result, { durationMs: performance.now() - start });
      } finally {
        closeSync(fd);
        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);
      }
      phase.status = phase.exitCode === 0 && !interrupted ? "passed" : "failed";
      if (interrupted) phase.interrupted = interrupted;
      const output = readFileSync(phase.log, "utf8");
      process.stdout.write(output);
      if (output.includes("test: Pi SDK not found.")) phase.prerequisiteFailure = "Pi SDK not found; no tests executed";
      save();
      if (phase.status !== "passed") {
        exitCode = phase.exitCode || (interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1);
        break;
      }
    }
    report.finalInputs = validationInputs(root, env);
    if (report.inputs.fingerprint !== report.finalInputs.fingerprint) {
      report.error = "Inputs changed during validation; results cannot qualify this source tree";
      exitCode = exitCode || 1;
    }
  } catch (error) {
    report.error = { code: error.code, message: error.message };
    exitCode = 1;
    console.error(`verify: ${error.message}`);
  }
  Object.assign(report, { status: exitCode === 0 ? "passed" : "failed", exitCode, finishedAt: new Date().toISOString() });
  save();
  console.log(`verify: ${report.status} (exit ${exitCode}); ${reportPath}`);
  return { exitCode, report, reportPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--integration") options.integration = true;
    else if (arg === "--reuse-check" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) options.reuseCheck = process.argv[++i];
    else throw new Error(`unknown or incomplete option: ${arg}`);
  }
  process.exitCode = (await runVerification(options)).exitCode;
}
