import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metalBackend } from "../scripts/metal-backend.mjs";
import { prepareBuild, kvmStatus } from "../lib/build-sandbox.ts";
import { snapshotCommand } from "../lib/isolated-command.ts";
import { claudeSearchToken } from "../lib/claude-search.ts";
import { nativeClipboardCommand } from "../extensions/tool-policy/host-access.ts";
import { hasMetalBackend } from "../extensions/tool-policy/command-access.ts";
import { metalFixture, fixtureMetalBackend } from "./metal-fixture.mjs";

// Simulate metadata only to test rejection before any filesystem or native call.
// These checks do not qualify an OS backend or run a device on another host.
test("native entry points refuse unsupported systems before reading paths or executing commands", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    for (const [os, cpu] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      Object.defineProperty(process, "arch", { ...arch, value: cpu });
      if (os !== "darwin" || cpu !== "arm64") {
        assert.throws(() => metalBackend(undefined), /native Apple Silicon/);
        assert.equal(hasMetalBackend(undefined), false);
      }
      if (os !== "linux") {
        assert.throws(() => prepareBuild(undefined, undefined), /require Linux/);
        assert.equal(kvmStatus().available, false);
        assert.throws(() => snapshotCommand(undefined, undefined, []), /require Linux/);
      }
      if (os !== "darwin") {
        assert.throws(nativeClipboardCommand, /requires macOS/);
        assert.equal(await claudeSearchToken(undefined, undefined, async () => assert.fail("must not read credentials")), undefined);
      } else assert.equal(nativeClipboardCommand(), "/usr/bin/pbcopy");
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

test("a synthetic Metal qualification never enables the real host capability", () => {
  const agent = realpathSync(mkdtempSync(join(tmpdir(), "pi-metal-not-native-")));
  try {
    metalFixture(agent);
    assert.ok(fixtureMetalBackend(agent).sha256);
    assert.throws(() => metalBackend(agent), /native Apple Silicon|needs qualification/);
    assert.equal(hasMetalBackend(agent), false);
  } finally { rmSync(agent, { recursive: true, force: true }); }
});
