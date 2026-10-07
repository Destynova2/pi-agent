#!/usr/bin/env node
// Offline CLI startup benchmark. Both inputs must print the same --version output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const [before, after] = process.argv.slice(2).map(path => resolve(path));
if (!before || !after) throw new Error("Usage: node scripts/bench-launcher.mjs <before launcher> <after launcher>");
const warmup = 5, samples = 40, permutations = 10000;
let seed = 20261007;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { medianMs: median(values), p95Ms: sorted[Math.ceil(values.length * .95) - 1],
    p99Ms: sorted[Math.ceil(values.length * .99) - 1],
    stddevMs: Math.sqrt(values.reduce((n, x) => n + (x - mean) ** 2, 0) / (values.length - 1)) };
}
const root = mkdtempSync(join(tmpdir(), "pi-launcher-bench-"));
const timings = { before: [], after: [] };
let expected;
try {
  for (let i = -warmup; i < samples; i++) {
    const order = random() < .5 ? [["before", before], ["after", after]] : [["after", after], ["before", before]];
    for (const [name, command] of order) {
      const output = join(root, "output"), fd = openSync(output, "w", 0o600);
      let result, elapsed;
      try {
        const start = performance.now();
        result = spawnSync(command, ["--version"], { stdio: ["ignore", fd, fd], env: { ...process.env, LC_ALL: "C" } });
        elapsed = performance.now() - start;
      } finally { closeSync(fd); }
      assert.ifError(result.error);
      assert.equal(result.status, 0, readFileSync(output, "utf8"));
      const actual = readFileSync(output, "utf8");
      expected ??= actual;
      assert.ok(actual.trim(), "CLI output must be consumed");
      assert.equal(actual, expected);
      if (i >= 0) timings[name].push(elapsed);
    }
  }
  const observed = Math.abs(median(timings.before) - median(timings.after));
  const pool = [...timings.before, ...timings.after];
  let extreme = 0;
  for (let i = 0; i < permutations; i++) {
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    if (Math.abs(median(pool.slice(0, samples)) - median(pool.slice(samples))) >= observed) extreme++;
  }
  const pValue = (extreme + 1) / (permutations + 1);
  console.log(JSON.stringify({ boundary: "whole CLI --version process, warm filesystem cache", warmup, samples,
    permutationSeed: 20261007, permutations, pValue,
    environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model },
    before: { command: before, ...summary(timings.before) }, after: { command: after, ...summary(timings.after) },
    significant: pValue < .05, medianReductionPercent: 100 * (1 - median(timings.after) / median(timings.before)),
    timings, output: expected.trim() }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
