// Trusted operator configuration. Ordinary commands never consult this capability.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";

export const METAL_CHECKS = ["backend_option", "compile_confined", "ordinary_before", "metal_compute", "network_control", "metal_file_network_boundary", "metal_managed_proxy_boundary", "metal_cancel", "metal_timeout", "ordinary_after"];

function openTrusted(path) {
  for (let parent = path; ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink() || realpathSync.native(parent) !== parent) throw new Error("Metal capability paths must be canonical and contain no symlinks");
    if (parent === dirname(parent)) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    closeSync(fd); throw new Error("Metal capability files must be owned regular files without links or group/other writes");
  }
  return fd;
}

function readJson(path) {
  const fd = openTrusted(path);
  try {
    if (fstatSync(fd).size > 128 * 1024) throw new Error("Metal capability report is too large");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function metalBackend(agentDir) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Metal capability requires native Apple Silicon qualification");
  try {
    const directory = join(agentDir, "backends/metal");
    const manifest = readJson(join(agentDir, "metal-backend.json"));
    const report = readJson(join(directory, "qualification.json"));
    if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "")) throw new Error("Invalid Metal backend manifest");
    if (report.schema !== 1 || report.qualified !== true || report.backendSha256 !== manifest.sha256 || report.platform !== process.platform || report.arch !== process.arch || report.osRelease !== release()) throw new Error("Metal backend needs qualification for this binary and OS release");
    if (!Array.isArray(report.checks) || report.checks.some(check => check.pass !== true) || METAL_CHECKS.some(name => report.checks.filter(check => check.name === name && check.pass === true).length !== 1)) throw new Error("Metal backend qualification is incomplete");
    const binary = join(directory, "codex"), fd = openTrusted(binary);
    let sha256;
    try {
      if (!(fstatSync(fd).mode & 0o100)) throw new Error("Metal backend is not executable");
      const hash = createHash("sha256"), buffer = Buffer.alloc(256 * 1024);
      for (let bytes; (bytes = readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, bytes));
      sha256 = hash.digest("hex");
    } finally { closeSync(fd); }
    if (sha256 !== manifest.sha256) throw new Error("Metal backend changed since qualification");
    return { binary, sha256 };
  } catch (error) {
    throw new Error(`Metal capability unavailable: ${error.message}. An operator must install a reviewed backend and its native qualification report; no fallback.`);
  }
}
