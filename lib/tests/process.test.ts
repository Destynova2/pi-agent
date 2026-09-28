import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process.ts";

// Chemin portable relatif à ce fichier de test : jamais $HOME ni un chemin d'installation utilisateur.
const GATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../gates/pi-orchestrate");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ["timeout", "abort", "parent-exits"] as const) {
  test(`supervision ${mode} : un descendant ignorant TERM ne survit pas`, async () => {
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
      const rejected = assert.rejects(job, mode === "timeout" ? /délai/ : /annulée/);
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

test("parent sorti avec succès : refuser et arrêter le descendant sans sorties héritées", async () => {
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

test("annulation Node → runner Python → groupe de hook distinct", async () => {
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
    await assert.rejects(runProcess("python3", ["-c", script], { cwd, timeoutMs: 500 }), /délai/);
    assert.equal(await readFile(ready, "utf8"), "ready");
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("sortie bornée, erreur de lancement et succès", async () => {
  const cwd = tmpdir();
  assert.equal(await runProcess(process.execPath, ["-e", "console.log('OK')"], { cwd }), "OK");
  await assert.rejects(runProcess("/not/an/executable", [], { cwd }));
  await assert.rejects(runProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { cwd, maxBytes: 100, graceMs: 10 }), /volumineuse/);
});
