import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../lib/process.ts";

test("user URL reads use the native sandbox without dialogs or a grant to subsequent Bash", { timeout: 90000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-native-")));
  const agent = join(root, "agent"), cwd = join(root, "project");
  const source = process.env.PI_WEB_SOURCE ?? fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(cwd); mkdirSync(agent);
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, grant: process.env.PI_CODEX_NETWORK_GRANTS };
  process.env.PI_CODING_AGENT_DIR = agent; delete process.env.PI_CODEX_NETWORK_GRANTS;
  const handlers = new Map(), tools = new Map();
  const ctx = { cwd, ui: { confirm() { assert.fail("No dialog for the user's exact URL"); }, select() { assert.fail("No dialog for the user's exact URL"); } } };
  try {
    for (const file of ["extensions/web/index.ts", "extensions/web/core.ts", "lib/confined.ts", "lib/claude-search.ts", "lib/audit-redaction.ts", "lib/process.ts", "lib/session-tasks.ts", "lib/web-consent.ts", "scripts/codex-shell.mjs", "scripts/codex-network.mjs", "scripts/web-read-worker.mjs", "scripts/metal-backend.mjs"]) {
      if (file.endsWith("metal-backend.mjs") && !existsSync(join(source, file))) continue;
      const path = join(agent, file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(source, file), path);
    }
    const web = (await import(pathToFileURL(join(agent, "extensions/web/index.ts")).href)).default;
    web({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand() {} });
    await handlers.get("session_start")({}, ctx);
    const launcher = join(agent, "scripts/codex-shell.mjs");
    const shell = command => runProcess(launcher, ["-c", command], { cwd, timeoutMs: 25000 });
    const denied = "/usr/bin/curl --silent --show-error --max-time 12 --output /dev/null --write-out '%{http_code}' https://example.com/";
    await assert.rejects(shell(denied), /CONNECT tunnel failed, response 403/, "ordinary Bash initially cannot reach the destination");
    handlers.get("input")({ text: "Lis https://example.com/", source: "interactive" }, ctx);
    const fetch = url => tools.get("web_fetch").execute("read", { url }, undefined, undefined, ctx);
    await assert.rejects(fetch("https://example.com/?upload=secret"), /WEB_URL_NOT_AUTHORIZED/);
    const result = await fetch("https://example.com/");
    assert.match(result.content[0].text, /Example Domain/);
    assert.equal(process.env.PI_CODEX_NETWORK_GRANTS, undefined);
    assert.equal(existsSync(join(agent, "network-grants")), false);
    await assert.rejects(shell(denied), /CONNECT tunnel failed, response 403/, "the read did not grant the host to Bash");
    await assert.rejects(runProcess(launcher, ["--web-url", "https://example.com/", "-c", "echo not-allowed"], { cwd }), /expects only/);
    await assert.rejects(shell(`${JSON.stringify(launcher)} --web-url https://example.com/`), /sandbox|permitted|denied/i, "an ordinary sandbox cannot promote itself to the exact-read path");
    const outside = join(root, "outside");
    await assert.rejects(shell(`touch ${JSON.stringify(outside)}`), /not permitted|denied|read-only/i);
    assert.equal(existsSync(outside), false);
    writeFileSync(join(agent, "network-policy.json"), '{"allow":[],"deny":["example.com"]}');
    await assert.rejects(fetch("https://example.com/"), /WEB_NETWORK_DENIED/);
    await assert.rejects(runProcess(launcher, ["--web-url", "https://example.com/"], { cwd }), /WEB_NETWORK_DENIED/);
    rmSync(join(agent, "network-policy.json"));
    await handlers.get("session_before_switch")({}, ctx);
    await assert.rejects(fetch("https://example.com/"), /WEB_URL_NOT_AUTHORIZED/);
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agent], ["PI_CODEX_NETWORK_GRANTS", previous.grant]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
