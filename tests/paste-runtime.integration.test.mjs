import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ProcessTerminal } from "@earendil-works/pi-tui";

// Opt-in integration check against the installed/staged runtime selected by PI_PACKAGE_JSON.
test("patched runtime keeps paste enabled only on a TTY and releases its timer on handoff", async () => {
  const descriptors = Object.fromEntries(["stdin", "stdout"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalKill = process.kill;
  const timers = new Set();
  const writes = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: false, write: text => { writes.push(text); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isRaw: false, setRawMode() {}, setEncoding() {}, resume() {}, pause() {} });
  try {
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    process.kill = () => true;
    globalThis.setInterval = (fn, ms) => {
      assert.equal(ms, 1000);
      const timer = { fn, unreferenced: false, unref() { this.unreferenced = true; return this; } };
      timers.add(timer);
      return timer;
    };
    globalThis.clearInterval = timer => { timers.delete(timer); };
    const terminal = new ProcessTerminal();
    terminal.start(() => {}, () => {});
    assert.equal(timers.size, 0);
    terminal.stop();
    stdout.isTTY = true;
    terminal.start(() => {}, () => {});
    assert.equal(timers.size, 1);
    const first = [...timers][0];
    assert.equal(first.unreferenced, true);
    const before = writes.length;
    first.fn();
    assert.equal(writes.length, before + 1);
    assert.equal(writes.at(-1), "\x1b[?2004h");
    terminal.start(() => {}, () => {});
    assert.equal(timers.size, 1);
    assert.ok(!timers.has(first));
    await terminal.drainInput(0, 0);
    assert.equal(timers.size, 0);
    terminal.stop();
    terminal.start(() => {}, () => {});
    assert.equal(timers.size, 1);
    terminal.stop();
    assert.equal(timers.size, 0);
    assert.ok(writes.includes("\x1b[?2004l"));
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    process.kill = originalKill;
    for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, key, descriptor);
  }
});
