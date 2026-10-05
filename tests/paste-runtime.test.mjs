import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { piPackageJson } from "./resolve-pi.mjs";
import { patchPaste } from "../scripts/patch-paste.mjs";

// Execute the published CLI's actual ProcessTerminal class with simulated terminal I/O.
// This tests a mode-2004 reset, not the user's physical terminal or desktop clipboard.
async function terminalCheck(source, patched) {
  const start = source.indexOf("var ProcessTerminal=class{");
  const end = source.indexOf(";var ", start);
  assert.ok(start >= 0 && end > start);
  const writes = [], timers = new Set();
  const stdout = { isTTY: true, write: s => writes.push(s), on() {}, removeListener() {} };
  const stdin = { setRawMode() {}, setEncoding() {}, resume() {}, pause() {}, on() {}, removeListener() {} };
  const Terminal = runInNewContext(`${source.slice(start, end)};ProcessTerminal`, {
    process: { env: {}, platform: "linux", stdout, stdin },
    refreshTerminalDimensions() {}, setKittyProtocolActive() {},
    setInterval(fn) { const timer = { fn, unref() { this.unrefed = true; } }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  });
  const terminal = new Terminal();
  terminal.queryAndEnableKittyProtocol = () => {};
  stdout.isTTY = false;
  terminal.start(() => {}, () => {});
  assert.equal(timers.size, 0);
  stdout.isTTY = true;
  terminal.start(() => {}, () => {});
  assert.ok(writes.includes("\x1b[?2004h"));
  writes.length = 0; // Simulated terminal mode reset after startup.
  for (const timer of timers) { assert.equal(timer.unrefed, true); timer.fn(); }
  assert.equal(writes.includes("\x1b[?2004h"), patched);
  terminal.start(() => {}, () => {});
  assert.equal(timers.size, patched ? 1 : 0, "double start must not leak a timer");
  await terminal.drainInput(0, 0);
  assert.equal(timers.size, 0);
  terminal.start(() => {}, () => {});
  terminal.stop();
  assert.equal(timers.size, 0);
  assert.ok(writes.includes("\x1b[?2004l"));
}

test("Pi 1.0.0 published CLI: reset still needs keepalive; pinned patch repairs it idempotently", async t => {
  // The patch fixture must not select the SDK used by every other integration test.
  const fixture = process.env.PI_PASTE_PACKAGE_JSON || piPackageJson;
  const manifest = fixture && JSON.parse(await readFile(fixture, "utf8"));
  if (manifest?.version !== "1.0.0") {
    if (process.env.PI_PASTE_PACKAGE_JSON || process.env.PI_TEST_INTEGRATION === "1") {
      assert.fail("Set PI_PASTE_PACKAGE_JSON to a pristine Pi 1.0.0 package");
    }
    return t.skip("requires pristine Pi 1.0.0 via PI_PASTE_PACKAGE_JSON (or PI_PACKAGE_JSON)");
  }
  assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
  const chunk = "dist/bundle/chunks/chunk-2KTBZM5G.js";
  const pristine = await readFile(join(dirname(fixture), chunk), "utf8");
  await terminalCheck(pristine, false);
  const root = await mkdtemp(join(tmpdir(), "pi-paste-1.0.0-"));
  try {
    await mkdir(join(root, "dist/bundle/chunks"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(join(root, chunk), pristine);
    const result = await patchPaste(root);
    assert.deepEqual(result.patched, ["bundled-cli-chunk"]);
    await terminalCheck(await readFile(join(root, chunk), "utf8"), true);
    assert.deepEqual((await patchPaste(root)).alreadyPatched, ["bundled-cli-chunk"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
