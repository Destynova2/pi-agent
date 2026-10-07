import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../extensions/terminal-paste/index.ts";

test("public widget keeps paste enabled only in an owned terminal and disposes every timer", t => {
  const descriptors = Object.fromEntries(["stdin", "stdout"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));
  const input = { isTTY: true, isRaw: true }, output = { isTTY: true };
  const timers = new Set(), handlers = new Map(), writes = [];
  let component, factory;
  t.mock.method(globalThis, "setInterval", (fn, delay) => {
    assert.equal(delay, 1000);
    const timer = { fn, unref() { this.unreferenced = true; } }; timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearInterval", timer => timers.delete(timer));
  t.after(() => { for (const [key, value] of Object.entries(descriptors)) Object.defineProperty(process, key, value); });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  const ctx = { mode: "rpc", ui: { setWidget(_key, next) {
    component?.dispose(); factory = next;
    component = next?.({ terminal: { write: text => writes.push(text) } });
  } } };
  register({ on: (name, handler) => handlers.set(name, handler) });
  const start = () => handlers.get("session_start")({}, ctx);
  start(); assert.equal(timers.size, 0);
  ctx.mode = "tui"; output.isTTY = false; start(); assert.equal(timers.size, 0);
  output.isTTY = true; input.isTTY = false; start(); assert.equal(timers.size, 0);
  input.isTTY = true; start(); assert.equal(timers.size, 1);
  assert.deepEqual(component.render(), []);
  assert.equal(writes.at(-1), "\x1b[?2004h");
  writes.length = 0;
  const tick = () => { for (const timer of timers) { assert.equal(timer.unreferenced, true); timer.fn(); } };
  tick(); assert.equal(writes.at(-1), "\x1b[?2004h", "recover from terminal mode reset");
  input.isRaw = false; const before = writes.length; tick(); assert.equal(writes.length, before, "child owns terminal");
  input.isRaw = true; tick(); assert.equal(writes.length, before + 1);
  start(); assert.equal(timers.size, 1, "reload cannot leak a timer");
  component.dispose(); assert.equal(timers.size, 0);
  component = factory({ terminal: { write: text => writes.push(text) } });
  assert.equal(timers.size, 1);
  handlers.get("session_shutdown")({}, ctx); assert.equal(timers.size, 0);
  handlers.get("session_shutdown")({}, ctx); assert.equal(timers.size, 0);
  assert.equal(writes.includes("\x1b[?2004l"), false, "Pi owns terminal teardown");
});
