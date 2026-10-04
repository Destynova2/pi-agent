import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { metalBackend } from "../scripts/metal-backend.mjs";
import { metalFixture } from "./metal-fixture.mjs";

test("Metal configuration refuses missing, incomplete, changed and linked capabilities", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-metal-config-")));
  try {
    for (const mode of ["absent", "valid", "incomplete", "failed", "os", "digest", "binary", "symlink", "hardlink", "writable", "directory"]) {
      const agent = join(root, mode); mkdirSync(agent);
      if (mode !== "absent") metalFixture(agent, undefined, report => {
        if (mode === "incomplete") report.checks.pop();
        if (mode === "failed") report.checks[0].pass = false;
        if (mode === "os") report.osRelease = "other-os";
        if (mode === "digest") report.backendSha256 = "0".repeat(64);
      });
      const binary = join(agent, "backends/metal/codex");
      if (mode === "binary") writeFileSync(binary, "different");
      if (mode === "writable") chmodSync(binary, 0o777);
      if (mode === "hardlink") linkSync(binary, join(agent, "alias"));
      if (mode === "symlink") { rmSync(binary); symlinkSync(join(agent, "qualification.json"), binary); }
      if (mode === "directory") { rmSync(binary); mkdirSync(binary); }
      if (mode === "valid") assert.equal(metalBackend(agent).binary, binary);
      else assert.throws(() => metalBackend(agent), /Metal capability unavailable/, mode);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
