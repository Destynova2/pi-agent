import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process.ts";

// Portable path relative to this test file: never $HOME or a user install path.
const GATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../gates/pi-orchestrate");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ["timeout", "abort", "parent-exits"] as const) {
  test(`supervision ${mode}: a descendant ignoring TERM does not survive`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-process-test-"));
    const ready = join(cwd, "ready");
    const marker = join(cwd, "survived");
    const parentPid = join(cwd, "parent.pid");
    const child = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),1000);`;
    const parent = `require('fs').writeFileSync(${JSON.stringify(parentPid)},String(process.pid)); ${mode === "parent-exits" ? "" : "process.on('SIGTERM',()=>{});"} require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:${JSON.stringify(mode === "parent-exits" ? "ignore" : "inherit")}}); setInterval(()=>{},1000);`;
    const controller = new AbortController();
    try {
      const job = runProcess(process.execPath, ["-e", parent], {
        cwd, signal: controller.signal, timeoutMs: mode === "timeout" ? 500 : 5000, graceMs: 50,
      });
      const rejected = assert.rejects(job, mode === "timeout" ? /deadline/ : /canceled/);
      for (let i = 0; i < 100; i++) {
        try { await access(ready); break; } catch { await delay(10); }
      }
      assert.equal(await readFile(ready, "utf8"), "ready");
      const awaitedPid = await readFile(parentPid, "utf8");
      if (mode !== "timeout") controller.abort();
      await rejected;
      assert.throws(() => process.kill(Number.parseInt(awaitedPid, 10), 0), { code: "ESRCH" });
      await delay(1100);
      await assert.rejects(access(marker));
    } finally { controller.abort(); await rm(cwd, { recursive: true, force: true }); }
  });
}

test("parent exited successfully: refuse and stop the descendant without inherited outputs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-background-test-"));
  const ready = join(cwd, "ready");
  const marker = join(cwd, "survived");
  const child = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),1000);`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(ready)}))process.exit(0)},10);`;
  try {
    await assert.rejects(runProcess(process.execPath, ["-e", parent], { cwd, graceMs: 50, timeoutMs: 5000 }), /descendants/);
    await delay(1100);
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Node cancellation → Python runner → distinct hook group", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cascade-test-"));
  const ready = join(cwd, "ready");
  const marker = join(cwd, "survived");
  const child = `import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(${JSON.stringify(ready)}).write_text('ready'); time.sleep(1); pathlib.Path(${JSON.stringify(marker)}).write_text('bad')`;
  const script = [
    "import sys,signal",
    `sys.path.insert(0, ${JSON.stringify(GATES_DIR)})`,
    "import gates",
    "signal.signal(signal.SIGTERM, gates.interrupted)",
    `gates.run([sys.executable, '-c', ${JSON.stringify(child)}], ${JSON.stringify(cwd)})`,
  ].join("\n");
  try {
    await assert.rejects(runProcess("python3", ["-c", script], { cwd, timeoutMs: 500 }), /deadline/);
    assert.equal(await readFile(ready, "utf8"), "ready");
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("bounded output, launch error and success", async () => {
  const cwd = tmpdir();
  assert.equal(await runProcess(process.execPath, ["-e", "console.log('OK')"], { cwd }), "OK");
  await assert.rejects(runProcess("/not/an/executable", [], { cwd }));
  await assert.rejects(runProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { cwd, maxBytes: 100, graceMs: 10 }), /too large/);
});

test("Darwin reaps a real exited child before retrying its group signal", { skip: process.platform !== "darwin" }, async () => {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('ready');process.exit(0)"], {
    cwd: tmpdir(), graceMs: 10,
    onStdout() {
      // Let the child exit while this parent's event loop cannot reap it yet.
      Atomics.wait(wait, 0, 0, 50);
      throw new Error("callback boom");
    },
  }), /callback boom/);
});

// Darwin killpg can return EPERM for a same-user zombie-only group until it is reaped.
// Exercise all signal sites without depending on the scheduler winning that race.
for (const target of ["SIGTERM", "SIGKILL", 0] as const) {
  test(`transient Darwin EPERM on ${target} retries the same signal after reaping`, { skip: process.platform !== "darwin" }, async (t) => {
    const realKill = process.kill.bind(process);
    let calls = 0;
    const spy = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      if (pid < -1 && signal === target && ++calls === 1) {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    try {
      if (target === 0) {
        assert.equal(await runProcess(process.execPath, ["-e", "console.log('OK')"], { cwd: tmpdir() }), "OK");
      } else {
        const script = target === "SIGKILL"
          ? "process.on('SIGTERM',()=>{}); console.log('x'.repeat(10000)); setTimeout(()=>{},5000)"
          : "console.log('x'.repeat(10000))";
        await assert.rejects(runProcess(process.execPath, ["-e", script], { cwd: tmpdir(), maxBytes: 100, graceMs: 10 }), /too large/);
      }
      assert.equal(calls, 2, "exactly one retry of the original signal, not a permission-bypassing probe");
    } finally { spy.mock.restore(); }
  });
}

test("cancellation during an EPERM retry cannot turn into success", { skip: process.platform !== "darwin" }, async (t) => {
  const controller = new AbortController();
  const realKill = process.kill.bind(process);
  let injected = false;
  const spy = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < -1 && signal === 0 && !injected) {
      injected = true;
      controller.abort();
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return realKill(pid, signal);
  });
  try {
    await assert.rejects(runProcess(process.execPath, ["-e", "console.log('OK')"], { cwd: tmpdir(), signal: controller.signal }), /canceled/);
    assert.equal(injected, true);
  } finally { spy.mock.restore(); }
});

test("persistent EPERM remains a cleanup error, not successful cancellation", async (t) => {
  const realKill = process.kill.bind(process);
  let pgid = 0;
  let attempts = 0;
  const spy = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < -1 && signal === "SIGKILL") {
      pgid = -pid;
      attempts++;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return realKill(pid, signal);
  });
  try {
    const script = "process.on('SIGTERM',()=>{}); console.log('x'.repeat(10000)); setTimeout(()=>{},5000)";
    await assert.rejects(runProcess(process.execPath, ["-e", script], { cwd: tmpdir(), maxBytes: 100, graceMs: 10 }), { code: "EPERM" });
    assert.equal(attempts, process.platform === "darwin" ? 2 : 1);
    assert.ok(pgid > 0);
    assert.equal(realKill(-pgid, 0), true, "a still-live group must not be declared cleaned up");
  } finally {
    spy.mock.restore();
    if (pgid) realKill(-pgid, "SIGKILL"); // Only our intentionally fault-injected fixture.
  }
});

test("onStdout streams chunks and resolves with an empty buffered result", async () => {
  const cwd = tmpdir();
  const chunks: Buffer[] = [];
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('hello streamed')"], {
    cwd, onStdout: (chunk) => chunks.push(chunk),
  });
  assert.equal(result, "");
  assert.equal(Buffer.concat(chunks).toString("utf8"), "hello streamed");
});

test("env is merged with process.env and NO_COLOR stays forced", async () => {
  const cwd = tmpdir();
  const script = "console.log(JSON.stringify({v: process.env.PI_TEST_VAR, noColor: process.env.NO_COLOR}))";
  const out = await runProcess(process.execPath, ["-e", script], { cwd, env: { PI_TEST_VAR: "custom", NO_COLOR: "0" } });
  assert.deepEqual(JSON.parse(out), { v: "custom", noColor: "1" });
});

test("a throwing onStdout callback stops the descendant and rejects instead of escaping", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-onstdout-throw-test-"));
  const ready = join(cwd, "ready");
  const marker = join(cwd, "survived");
  const child = `process.on('SIGTERM',()=>{}); process.stdout.write('go'); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),1000);`;
  try {
    await assert.rejects(
      runProcess(process.execPath, ["-e", child], {
        cwd, graceMs: 50, timeoutMs: 5000,
        onStdout: () => { throw new Error("callback boom"); },
      }),
      /callback boom/,
    );
    for (let i = 0; i < 100; i++) {
      try { await access(ready); break; } catch { await delay(10); }
    }
    await delay(1100);
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("output limit is still enforced while streaming stdout", async () => {
  const cwd = tmpdir();
  const chunks: Buffer[] = [];
  await assert.rejects(
    runProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], {
      cwd, maxBytes: 100, graceMs: 10, onStdout: (chunk) => chunks.push(chunk),
    }),
    /too large/,
  );
});
