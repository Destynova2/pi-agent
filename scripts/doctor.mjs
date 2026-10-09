#!/usr/bin/env node
// Environment diagnostic for a pi agent directory. Node stdlib only.
// Never reads or displays the content of auth.json: presence of secrets is not validated here.
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandExists } from "./lib.mjs";
import { PACKAGE_DIRECTORY } from "../lib/runtime-paths.mjs";
import { hasRequiredExtensionFilters } from "../lib/settings-policy.mjs";

export const REQUIRED_COMMANDS = ["git", "curl", "pi", "codex"];
export const OPTIONAL_COMMANDS = ["graphify", "jj", "prek", "gitleaks", "python3", "claude", "gh", "podman"];
export const BUNDLED_TOOLS = ["gates/pi-prek"];
// Deployment readiness, not an end-to-end proof. Compare the executable boundaries to this source.
export const CONFINED_RUNTIME_FILES = [
  "package.json", "lib/runtime-paths.mjs", "lib/settings-policy.mjs", "extensions/background-bash/index.ts", "extensions/background-bash/core.ts",
  "extensions/terminal-paste/index.ts", "extensions/task-progress/index.ts",
  "scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/codex-tool.mjs",
  "scripts/confined-tool.mjs", "scripts/confined-lsp-worker.mjs",
  "scripts/git-operation.mjs", "scripts/git-hook-guard.mjs", "scripts/web-read-worker.mjs", "scripts/jj-checkpoint.mjs",
  "lib/jj-checkpoint.ts", "extensions/tool-policy/jj-checkpoint.ts",
  "lib/git-transaction.ts", "extensions/tool-policy/git-access.ts", "extensions/tool-policy/git-access-core.ts",
  "lib/git-command.ts", "lib/git-init.ts", "extensions/tool-policy/git-init.ts", "scripts/git-init.mjs",
  "scripts/git-worktree.mjs", "extensions/tool-policy/git-worktree.ts", "lib/git-worktree.ts", "lib/approval-dialog.ts",
  "lib/confined.ts", "lib/claude-search.ts", "lib/confined-tools.ts", "lib/resolve-pi.mjs", "lib/rpc-process.ts", "lib/process.ts",
  "lib/read-request.mjs", "lib/browser-mcp.ts", "lib/podman-connection.ts",
  "extensions/tool-policy/index.ts", "extensions/confined-lsp/index.ts",
  "extensions/tool-policy/podman-access.ts", "extensions/tool-policy/command-access.ts", "extensions/tool-policy/network.ts",
  "extensions/tool-policy/isolated-command.ts", "lib/isolated-command.ts", "lib/private-ipc-seccomp.mjs", "extensions/notes/incidents.ts",
  "lib/approval-review.ts", "lib/mcp-approvals.ts", "lib/permission-audit.ts",
  "extensions/audit/index.ts", "lib/audit-storage.ts", "lib/audit-events.ts", "lib/audit-redaction.ts", "lib/audit-ui.ts", "lib/audit-report.ts", "scripts/audit-report.mjs",
  "extensions/confined-lsp/pi-lsp-module-hook.mjs", "extensions/confined-lsp/worker-session.mjs",
  "extensions/confined-lsp/jail.ts", "extensions/confined-lsp/readonly-settings.mjs",
  "extensions/confined-lsp/piped-spawn.mjs",
  "extensions/graphify/index.ts", "extensions/graphify/worker.ts",
  "extensions/notes.ts", "extensions/notes/worker.ts", "extensions/git-inspect/index.ts",
  "extensions/ci-watch/index.ts", "extensions/ci-watch/worker.ts", "extensions/web/index.ts", "extensions/web/core.ts",
  "extensions/mcp/index.ts", "extensions/mcp/client.ts", "extensions/subagent/index.ts",
  "extensions/subagent/render.ts", "extensions/subagent/results.ts",
  "extensions/orchestrate/index.ts", "gates/pi-orchestrate/gates.py",
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function defaultTarget(env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function checkNodeVersion() {
  let required = ">=22.19";
  try {
    const pkg = JSON.parse(await readFile(join(SCRIPT_DIR, "..", "package.json"), "utf8"));
    if (pkg.engines?.node) required = pkg.engines.node;
  } catch {
    // package.json missing or invalid: keep the announced default
  }
  const match = /(\d+)\.(\d+)/.exec(required);
  const minMajor = match ? Number(match[1]) : 22;
  const minMinor = match ? Number(match[2]) : 19;
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > minMajor || (major === minMajor && minor >= minMinor);
  return { name: `node ${required}`, required: true, ok, detail: process.versions.node };
}

async function checkNodeSqlite() {
  try {
    await import("node:sqlite");
    return { name: "node:sqlite", required: true, ok: true };
  } catch (err) {
    return { name: "node:sqlite", required: true, ok: false, detail: err.message };
  }
}

async function checkBundledTool(target, relPath) {
  const p = join(target, PACKAGE_DIRECTORY, relPath);
  try {
    await access(p, fsConstants.X_OK);
    return { name: relPath, required: false, ok: true };
  } catch {
    return { name: relPath, required: false, ok: false, detail: `missing or not executable (${p})` };
  }
}

async function checkInstalledRuntime(target) {
  const results = [];
  for (const file of CONFINED_RUNTIME_FILES) {
    try {
      const [source, installed] = await Promise.all([readFile(join(SCRIPT_DIR, "..", file)), readFile(join(target, PACKAGE_DIRECTORY, file))]);
      results.push({ name: file, required: true, ok: source.equals(installed), detail: source.equals(installed) ? "matches source" : "differs from source; not deployed" });
    } catch (error) { results.push({ name: file, required: true, ok: false, detail: error.message }); }
  }
  try {
    const settings = JSON.parse(await readFile(join(target, "settings.json"), "utf8"));
    results.push({ name: "builtin host MCP filtered", required: true, ok: hasRequiredExtensionFilters(settings) });
    const lsp = settings.packages?.find(p => typeof p === "object" && p.source === "npm:@ian-pascoe/pi-lsp@0.4.4");
    results.push({ name: "upstream LSP hooks filtered", required: true, ok: Array.isArray(lsp?.extensions) && lsp.extensions.length === 0 });
    results.push({ name: "native Pi package", required: true, ok: settings.packages?.includes(join(target, PACKAGE_DIRECTORY)) });
    const background = settings.packages?.find(p => typeof p === "object" && p.source === "npm:@richardgill/pi-background-bash@0.0.3");
    results.push({ name: "upstream foreground Bash filtered", required: true, ok: Array.isArray(background?.extensions) && background.extensions.length === 0 });
    results.push({ name: "confined shellPath", required: true, ok: settings.shellPath === join(target, PACKAGE_DIRECTORY, "scripts/codex-shell.mjs") });
    for (const [name, version] of [["@ian-pascoe/pi-lsp", "0.4.4"], ["typescript", "7.0.2"], ["@richardgill/pi-background-bash", "0.0.3"]]) {
      let actual;
      try { actual = JSON.parse(await readFile(join(target, "npm/node_modules", name, "package.json"), "utf8")).version; } catch { /* Report missing dependency below. */ }
      results.push({ name: `${name}@${version}`, required: true, ok: actual === version, detail: actual ?? "not installed" });
    }
    results.push({ name: "MCP configuration file", required: false, ok: await access(join(target, "mcp.json")).then(() => true, () => false), detail: "presence only; local stdio servers still require runtime validation" });
  } catch (error) { results.push({ name: "installed settings", required: true, ok: false, detail: error.message }); }
  return results;
}

/**
 * Runs the environment checks. `strict: true` also fails on missing
 * optional tools; by default they only produce a warning.
 */
export async function runDoctor({ target, strict = false, installed = false, env = process.env } = {}) {
  const resolvedTarget = resolve(target ?? defaultTarget(env));
  const results = [];

  results.push(await checkNodeVersion());
  results.push(await checkNodeSqlite());
  for (const cmd of REQUIRED_COMMANDS) {
    results.push({ name: cmd, required: true, ok: commandExists(cmd, env) });
  }
  for (const cmd of OPTIONAL_COMMANDS) {
    results.push({ name: cmd, required: false, ok: commandExists(cmd, env) });
  }
  for (const tool of BUNDLED_TOOLS) {
    results.push(await checkBundledTool(resolvedTarget, tool));
  }

  if (installed) results.push(...await checkInstalledRuntime(resolvedTarget));

  const missingRequired = results.filter((r) => r.required && !r.ok);
  const missingOptional = results.filter((r) => !r.required && !r.ok);
  const ok = missingRequired.length === 0 && (!strict || missingOptional.length === 0);

  return { target: resolvedTarget, strict, results, missingRequired, missingOptional, ok };
}

function parseArgs(argv) {
  const out = { target: undefined, strict: false, installed: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") out.target = argv[++i];
    else if (arg === "--strict") out.strict = true;
    else if (arg === "--installed") out.installed = true;
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/doctor.mjs [--target <path>] [--strict] [--installed]

  --target <path>     Agent directory to diagnose (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --strict            Also fail if an optional tool is missing
  --installed         Also check deployed executors, LSP filtering and pinned server packages
`);
}

function printReport(result) {
  console.log(`doctor: target ${result.target}`);
  for (const r of result.results) {
    const label = r.required ? "required " : "optional";
    const status = r.ok ? "ok" : "missing";
    console.log(`  [${status === "ok" ? "OK" : "!!"}] ${label} ${r.name}: ${status}${r.detail ? ` (${r.detail})` : ""}`);
  }
  if (result.missingRequired.length > 0) {
    console.error(`doctor: missing required tools: ${result.missingRequired.map((r) => r.name).join(", ")}`);
  }
  if (result.missingOptional.length > 0) {
    console.log(`doctor: missing optional tools: ${result.missingOptional.map((r) => r.name).join(", ")}${result.strict ? " (fails in --strict mode)" : ""}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`doctor: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  const result = await runDoctor(args);
  printReport(result);
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
