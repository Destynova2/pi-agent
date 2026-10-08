#!/usr/bin/env node
// Quick check without a new dependency: .mjs syntax (`node --check`) and
// whitespace hygiene (trailing space/tab, final newline), plus
// `git diff --check` over the whole tree unless --skip-git-diff (used by the tests).
// Leading indentation tabs are a legitimate style (see
// extensions/graphify/tests/*.mjs): only trailing tabs at end of line are a defect.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validationInputs } from "./validation-inputs.mjs";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "bin", "git", "npm", "sessions", ".agent", "skills"]);

export function collectMjs(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".mjs")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

export function checkWhitespace(file) {
  const content = readFileSync(file, "utf8");
  const problems = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${file}:${i + 1}: trailing space(s) or tab(s) at end of line`);
  });
  if (content.length > 0 && !content.endsWith("\n")) {
    problems.push(`${file}: missing final newline`);
  }
  return problems;
}

export function runCheck({ dir, skipGitDiff = false, evidence, reuseEvidence } = {}) {
  const root = dir ? resolve(dir) : fileURLToPath(new URL("..", import.meta.url));
  const files = collectMjs(root);
  const messages = [];
  let ok = true;
  const started = performance.now();
  const inputs = validationInputs(root);
  let reused = false;
  if (reuseEvidence) {
    try {
      const previous = JSON.parse(readFileSync(reuseEvidence, "utf8"));
      reused = previous.version === 1 && previous.ok === true && previous.inputs?.fingerprint === inputs.fingerprint;
    } catch { /* Missing or invalid evidence requires a fresh check. */ }
  }

  for (const file of reused ? [] : files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) {
      ok = false;
      messages.push(`${file}: syntax error\n${(res.stderr || "").trim()}`);
    }
    const problems = checkWhitespace(file);
    if (problems.length > 0) {
      ok = false;
      messages.push(...problems);
    }
  }

  if (!skipGitDiff) {
    for (const args of [["diff", "--check"], ["diff", "--cached", "--check"]]) {
      const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (res.status !== 0) {
        ok = false;
        messages.push((res.stdout || res.stderr || res.error?.message || `git ${args.join(" ")} exited ${res.status}`).trim());
      }
    }
  }

  if (validationInputs(root).fingerprint !== inputs.fingerprint) {
    ok = false;
    messages.push("check: inputs changed during validation; run the check again");
  }
  const result = { version: 1, ok, files, messages, inputs, reused, durationMs: performance.now() - started };
  if (evidence) writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

function parseArgs(argv) {
  const out = { dir: undefined, skipGitDiff: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--skip-git-diff") out.skipGitDiff = true;
    else if (arg === "--evidence" || arg === "--reuse-evidence") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a path`);
      out[arg === "--evidence" ? "evidence" : "reuseEvidence"] = argv[++i];
    }
    else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log("Usage: node scripts/check.mjs [--dir <path>] [--skip-git-diff] [--evidence <path>] [--reuse-evidence <path>]");
    return;
  }
  const result = runCheck(args);
  for (const m of result.messages) console.error(m);
  console.log(`check: ${result.files.length} .mjs file(s) ${result.reused ? "unchanged, syntax evidence reused" : "analyzed"}${result.ok ? ", all clean" : ""}`);
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
