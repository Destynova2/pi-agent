import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

type Handler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const method of ["cancel", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_start"]) {
  test(`commande orchestrate : exclusion concurrente et ${method}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-orchestrate-lifecycle-"));
    const oldHome = process.env.HOME;
    let handler: Handler | undefined;
    const events = new Map<string, () => Promise<void>>();
    const notifications: string[] = [];
    const ready = join(home, "ready");
    const marker = join(home, "survived");
    let job: Promise<void> | undefined;
    let complete = false;
    try {
      await mkdir(join(home, ".local/bin"), { recursive: true });
      const child = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),2000);`;
      const parent = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); child.on('error',error=>{console.error(error);process.exit(1)}); child.on('exit',code=>{console.error('fixture child exited '+code);process.exit(code??1)}); setInterval(()=>{},1000);`;
      await writeFile(join(home, ".local/bin/pi-prek"), `#!${process.execPath}\n${parent}\n`, { mode: 0o700 });
      process.env.HOME = home;
      register({
        registerCommand: (_name: string, definition: { handler: Handler }) => { handler = definition.handler; },
        on: (event: string, callback: () => Promise<void>) => { events.set(event, callback); },
      } as unknown as ExtensionAPI);
      assert.ok(handler);
      const ctx = { cwd: home, ui: {
        setStatus: () => undefined,
        notify: (text: string) => { notifications.push(text); },
      } } as unknown as Parameters<Handler>[1];
      job = handler("gates full", ctx);
      void job.then(() => { complete = true; });
      for (let i = 0; i < 250 && !complete; i++) {
        try { await access(ready); break; } catch { await delay(20); }
      }
      assert.equal(await readFile(ready, "utf8").catch(() => "missing"), "ready", notifications.join("\n"));
      await handler("gates full", ctx);
      assert.ok(notifications.some((text) => text.includes("déjà en cours")));
      if (method === "cancel") await handler("cancel", ctx);
      else {
        const transition = events.get(method);
        assert.ok(transition);
        await transition();
      }
      await job;
      await delay(2100);
      assert.ok(notifications.some((text) => text.includes("BLOQUÉS")));
      await assert.rejects(access(marker));
      await handler("cancel", ctx);
      assert.ok(notifications.includes("Aucun gate en cours."));
    } finally {
      await events.get("session_shutdown")?.();
      await job;
      process.env.HOME = oldHome;
      await rm(home, { recursive: true, force: true });
    }
  });
}
