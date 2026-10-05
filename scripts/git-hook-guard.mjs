// Immutable runtime hook dispatcher, inside Codex. Preserve original hooks and stdin.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [hook, ...args] = process.argv.slice(2);
const original = process.env.PI_GIT_ACCESS_ORIGINAL_HOOKS;
const tree = process.env.PI_GIT_ACCESS_EXPECTED_TREE;
const head = process.env.PI_GIT_ACCESS_EXPECTED_HEAD;
const branch = process.env.PI_GIT_ACCESS_EXPECTED_REF;
if (!["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"].includes(hook) || !original || !/^[a-f0-9]{40,64}$/.test(tree ?? "") || head === undefined || !branch) throw new Error("Missing Git hook gate context");
const chunks = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error("Oversized hook input"); chunks.push(chunk); }
const input = Buffer.concat(chunks);
// Git's native hook runner takes a filename; do not reopen /dev/stdin in the jail.
const scratch = mkdtempSync(join(tmpdir(), "git-hook-stdin-"));
let result;
try {
  const path = join(scratch, "input"); writeFileSync(path, input, { flag: "wx", mode: 0o600 });
  result = spawnSync("/usr/bin/git", ["-c", `core.hooksPath=${original}`, "hook", "run", "--ignore-missing", `--to-stdin=${path}`, hook, "--", ...args], { stdio: ["ignore", "inherit", "inherit"] });
} finally { rmSync(scratch, { recursive: true, force: true }); }
if (result.error || result.signal || result.status !== 0) process.exitCode = result.status || 1;
else if (["pre-commit", "prepare-commit-msg", "commit-msg"].includes(hook)) {
  const check = spawnSync("/usr/bin/git", ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", tree, "--"], { stdio: ["ignore", "ignore", "pipe"] });
  if (check.error || check.signal || check.status !== 0) { console.error("PI_GIT_GUARD_INDEX_CHANGED"); process.exitCode = 1; }
} else if (hook === "reference-transaction" && args[0] === "prepared") {
  // Git invokes this while its ref transaction is locked, before changing history.
  const lines = input.toString("utf8").trim().split("\n");
  let valid = lines.length > 0, reason = "input";
  for (const line of lines) {
    const [old, next, ref, extra] = line.split(" ");
    // A normal commit clears this already-absent pseudoref after updating HEAD.
    if (ref === "AUTO_MERGE" && !extra && /^0{40}(?:0{24})?$/.test(old ?? "") && old === next) continue;
    if (extra || !/^[a-f0-9]{40,64}$/.test(next ?? "") || ![branch, "HEAD"].includes(ref) || (head ? old !== head : !/^0{40}(?:0{24})?$/.test(old ?? ""))) { valid = false; reason = "unexpected reference or old object"; break; }
    const value = spawnSync("/usr/bin/git", ["--no-lazy-fetch", "rev-parse", "--verify", `${next}^{tree}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (value.status !== 0 || value.stdout.trim() !== tree) { valid = false; reason = "unexpected tree"; break; }
  }
  const current = spawnSync("/usr/bin/git", ["symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (current.status !== 0 || current.stdout.trim() !== branch) { valid = false; reason = "current branch changed"; }
  if (!valid) { console.error(`PI_GIT_GUARD_REF_CHANGED: ${reason}`); process.exitCode = 1; }
}
