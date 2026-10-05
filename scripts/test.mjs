#!/usr/bin/env node
// Runs the repo's `node:test` tests (*.test.ts and *.test.mjs), excluding vendored dirs.
// By default: standard suite (*.integration.test.* files excluded). `--integration`: runs
// the ENTIRE suite (nothing excluded) with PI_TEST_INTEGRATION=1, which turns every explicit
// skip for a missing external dependency (git/jj/graphify/Pi installed...) into a hard failure,
// then also runs `python3 -m unittest test_gates` (gates/pi-orchestrate) if python3 is
// available. Never a fake pass: a missing dependency fails, it does not pass silently.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commandExists } from "./lib.mjs";
import { sandboxBackend } from "./codex-shell.mjs";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "bin", "git", "npm", "sessions", ".agent", "skills"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = resolve(SCRIPT_DIR, "..", "tests", "resolve-pi.mjs");
const GATES_TEST_SCRIPT = resolve(SCRIPT_DIR, "..", "gates", "pi-orchestrate", "test_gates.py");

/**
 * `all: true` ignores the standard/integration distinction and returns every test file:
 * used by `--integration`, which must run the entire suite, not just the files
 * named `*.integration.test.*`.
 */
export function collectTests(root, { integration = false, all = false } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.test\.(ts|mjs)$/.test(entry.name)) continue;
      const isIntegration = entry.name.includes(".integration.test.");
      if (all || (integration ? isIntegration : !isIntegration)) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * The bootstrap (redirecting imports to the real Pi install) only makes sense for this
 * real repo: a suite pointed at a fixture directory (--dir, used by the runner's own
 * tests) must not load it without being asked explicitly (--bootstrap).
 */
export function shouldBootstrap({ dir, bootstrap = false } = {}) {
  return dir === undefined || bootstrap;
}

function parseArgs(argv) {
  const out = { integration: false, dir: undefined, bootstrap: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--integration") out.integration = true;
    else if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--bootstrap") out.bootstrap = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

/**
 * Runs `python3 -m unittest test_gates` (gates/pi-orchestrate/test_gates.py). Skipped
 * explicitly (with a message, not a silent pass) if python3 or the script are
 * missing; otherwise run for real, including its own failures.
 */
function runPythonGates(env) {
  if (!existsSync(GATES_TEST_SCRIPT)) {
    console.log("test: gates/pi-orchestrate/test_gates.py missing, explicitly skipped");
    return 0;
  }
  if (!commandExists("python3", env)) {
    console.log("test: python3 missing, gates/pi-orchestrate/test_gates.py explicitly skipped");
    return 0;
  }
  console.log("test: python3 -m unittest test_gates (gates/pi-orchestrate)");
  const res = spawnSync("python3", ["-m", "unittest", "test_gates", "-v"], {
    cwd: dirname(GATES_TEST_SCRIPT),
    env,
    stdio: "inherit",
  });
  return res.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.dir ?? fileURLToPath(new URL("..", import.meta.url)));
  const files = collectTests(root, { all: args.integration });
  if (files.length === 0) {
    console.log(args.integration ? "test: no tests found for the integration suite" : "test: no tests found");
    process.exitCode = 0;
    return;
  }

  const useBootstrap = shouldBootstrap(args) && existsSync(BOOTSTRAP_PATH);
  if (useBootstrap && !(await import("../lib/resolve-pi.mjs")).piPackageJson) {
    console.error("test: Pi SDK not found. If pi is a shell wrapper, set PI_PACKAGE_JSON to the installed @earendil-works/pi-coding-agent/package.json (see INSTALLATION.md). No tests executed.");
    process.exitCode = 1;
    return;
  }

  console.log(`test: ${files.length} file(s)${args.integration ? " (full suite, PI_TEST_INTEGRATION=1)" : ""}`);
  // Native fixtures spawn their own process trees, compilers and sandbox brokers.
  // Bound file concurrency so startup is not starved by one worker per CPU.
  const nodeArgs = ["--test", "--test-concurrency=4"];
  if (useBootstrap) nodeArgs.push("--import", BOOTSTRAP_PATH);
  nodeArgs.push(...files);

  const env = { ...process.env, PI_CODEX_SANDBOX_BIN: sandboxBackend(), ...(args.integration ? { PI_TEST_INTEGRATION: "1" } : {}) };
  const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env });
  let exitCode = result.status ?? 1;

  if (args.integration) {
    const gatesStatus = runPythonGates(env);
    if (gatesStatus !== 0) exitCode = exitCode === 0 ? gatesStatus : exitCode;
  }

  process.exitCode = exitCode;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
