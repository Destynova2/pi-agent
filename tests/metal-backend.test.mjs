import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { metalBackend } from "../scripts/metal-backend.mjs";
import { metalFixture, fixtureMetalBackend } from "./metal-fixture.mjs";

test("Metal rejects unsupported platforms before reading backend configuration", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    for (const [os, cpu] of [["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["darwin", "x64"]]) {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      Object.defineProperty(process, "arch", { ...arch, value: cpu });
      assert.throws(() => metalBackend(undefined), /Metal capability requires native Apple Silicon qualification/, `${os}/${cpu}`);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

test("Metal report validation with a synthetic host refuses missing, incomplete, changed and linked capabilities", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-metal-config-")));
  try {
    for (const mode of ["absent", "valid", "incomplete", "failed", "os", "platform", "arch", "digest", "binary", "symlink", "hardlink", "writable", "directory"]) {
      const agent = join(root, mode); mkdirSync(agent);
      if (mode !== "absent") metalFixture(agent, undefined, report => {
        if (mode === "incomplete") report.checks.pop();
        if (mode === "failed") report.checks[0].pass = false;
        if (mode === "os") report.osRelease = "other-os";
        if (mode === "platform") report.platform = "linux";
        if (mode === "arch") report.arch = "x64";
        if (mode === "digest") report.backendSha256 = "0".repeat(64);
      });
      const binary = join(agent, "backends/metal/codex");
      if (mode === "binary") writeFileSync(binary, "different");
      if (mode === "writable") chmodSync(binary, 0o777);
      if (mode === "hardlink") linkSync(binary, join(agent, "alias"));
      if (mode === "symlink") { rmSync(binary); symlinkSync(join(agent, "qualification.json"), binary); }
      if (mode === "directory") { rmSync(binary); mkdirSync(binary); }
      if (mode === "valid") assert.equal(fixtureMetalBackend(agent).binary, binary);
      else assert.throws(() => fixtureMetalBackend(agent), /Metal capability unavailable/, mode);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
