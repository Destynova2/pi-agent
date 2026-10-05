// pi-background-bash 0.0.3 drops the SDK's structured error result.
// Use its own process exit code, never infer success from output text.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const ORIGINAL_SHA256 = "127a73b1d2986585acfcc0ca89f4954d54cbcb60a4a01768f57fdd1e064bced4";
const before = `  if (outcome.error) {
    return { error: stableError(outcome.error, managed, resultText(captured)) };
  }`;
const after = `  // pi-agent: structured SDK failures must not become foreground successes.
  if (outcome.error || managed.exitCode !== 0) {
    const error = outcome.error ?? new Error(
      managed.exitCode === undefined
        ? "Command terminated without an exit code"
        : \`Command exited with code \${managed.exitCode}\`,
    );
    return { error: stableError(error, managed, resultText(captured)) };
  }`;
const digest = value => createHash("sha256").update(value).digest("hex");
async function readArtifact(path) {
  if (await realpath(path) !== path) throw new Error("Linked artifact refused");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Linked, special or oversized artifact refused");
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length !== stat.size || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) throw new Error("Artifact changed during read");
    return { bytes: bytes.subarray(0, length), stat };
  } finally { await file.close(); }
}
export function transformBackgroundBash(source, reverse = false) {
  const search = reverse ? after : before, replacement = reverse ? before : after;
  if (source.split(search).length !== 2) throw new Error("Unknown background-bash patch input");
  return source.replace(search, replacement);
}
export async function patchBackgroundBash(directory) {
  const root = resolve(directory);
  if (await realpath(root) !== root) throw new Error("Canonical package directory required");
  const rootStat = await lstat(root);
  const manifest = JSON.parse((await readArtifact(join(root, "package.json"))).bytes.toString("utf8"));
  if (manifest.name !== "@richardgill/pi-background-bash" || manifest.version !== "0.0.3") throw new Error("Only @richardgill/pi-background-bash 0.0.3 is supported");
  const path = join(root, "src/tools.ts"), { bytes, stat } = await readArtifact(path);
  const source = bytes.toString("utf8");
  if (digest(source) !== ORIGINAL_SHA256) {
    if (digest(transformBackgroundBash(source, true)) !== ORIGINAL_SHA256) throw new Error("Modified background-bash artifact refused");
    return { root, patched: false };
  }
  const content = transformBackgroundBash(source), backup = `${path}.before-pi-exit-status`, temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(backup, source, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST" || digest((await readArtifact(backup)).bytes) !== ORIGINAL_SHA256) throw error; }
  try {
    await writeFile(temp, content, { flag: "wx", mode: stat.mode });
    const current = await readArtifact(path), currentRoot = await lstat(root);
    if (currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev || current.stat.ino !== stat.ino || current.stat.dev !== stat.dev || digest(current.bytes) !== ORIGINAL_SHA256) throw new Error("Patch target changed; no replacement performed");
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
  return { root, patched: true, backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/patch-background-bash.mjs <canonical package directory>");
  console.log(JSON.stringify(await patchBackgroundBash(process.argv[2])));
}
