#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVISION = "a956835d020762cb2b570053af06f643a11c0ecc";
const LOCK_SHA256 = "5553f06583159ed64666b6eb4beea3154e06b612e6312528131bdc226a6a860c";
const sha256 = value => createHash("sha256").update(value).digest("hex");

// The upstream release updates Cargo.toml but leaves local package versions at
// 0.0.0 in Cargo.lock. External dependency versions, sources and checksums stay fixed.
export function normalizeReleaseLock(original) {
  assert.equal(sha256(original), LOCK_SHA256, "unexpected upstream lockfile");
  let count = 0;
  const result = original.split("[[package]]").map(block => {
    if (!/^source = /m.test(block) && /^version = "0\.0\.0"$/m.test(block)) {
      count++;
      return block.replace(/^version = "0\.0\.0"$/m, 'version = "0.160.0"');
    }
    return block;
  }).join("[[package]]");
  assert.equal(count, 159, "upstream workspace package inventory changed");
  return result;
}

export function prepare(destination) {
  if (!isAbsolute(destination) || destination !== resolve(destination)) throw new Error("Use a canonical absolute checkout path");
  if (existsSync(destination)) throw new Error("Destination must not exist; existing work is never reset");
  const patch = fileURLToPath(new URL("./codex-0.160.0-metal.patch", import.meta.url));
  const patchBytes = readFileSync(patch);
  const git = args => execFileSync("git", args, { cwd: destination, encoding: "utf8", timeout: 120000 });
  execFileSync("git", ["clone", "--depth", "1", "--branch", "rust-v0.160.0", "https://github.com/openai/codex.git", destination], { stdio: "inherit", timeout: 120000 });
  assert.equal(git(["rev-parse", "HEAD"]).trim(), REVISION, "tag moved; refusing to patch");
  const lockfile = join(destination, "codex-rs/Cargo.lock");
  const normalized = normalizeReleaseLock(readFileSync(lockfile, "utf8"));
  git(["apply", "--check", patch]);
  git(["apply", patch]);
  writeFileSync(lockfile, normalized);
  const result = { revision: REVISION, patchSha256: sha256(patchBytes), externalDependenciesChanged: false,
    workspaceVersionsNormalized: 159, checkout: destination, installed: false };
  writeFileSync(join(destination, "metal-preparation.json"), JSON.stringify(result, null, 2)+"\n", { flag: "wx", mode: 0o600 });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node experiments/metal/prepare.mjs /new/absolute/checkout");
  console.log(JSON.stringify(prepare(process.argv[2]), null, 2));
}
