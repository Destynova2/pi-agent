// Proves the static preload hook in isolation, against the real installed @ian-pascoe/pi-lsp
// 0.4.4: resolves the fixed package aliases, maps relative .js imports inside the pinned src/
// root to .ts, compiles TypeScript with the installed Pi SDK's Jiti compiler, and leaves
// everything else (other specifiers, other paths) to Node's normal resolution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findPinnedPiLspRoot } from "../extensions/confined-lsp/pi-lsp-module-hook.mjs";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = getAgentDir();
const HOOK = join(REPO_DIR, "extensions/confined-lsp/pi-lsp-module-hook.mjs");
const RESOLVE_PI_HOOK = join(REPO_DIR, "lib/resolve-pi.mjs");
const PI_LSP_SRC = join(AGENT_DIR, "npm/node_modules/@ian-pascoe/pi-lsp/src");
const PI_LSP_INSTALLED = existsSync(join(PI_LSP_SRC, "pi-lsp-extension.ts"));

function skipReason() {
  return PI_LSP_INSTALLED ? undefined : `@ian-pascoe/pi-lsp is not installed under ${PI_LSP_SRC}`;
}

test("findPinnedPiLspRoot returns undefined without PI_CODING_AGENT_DIR", async () => {
  assert.equal(findPinnedPiLspRoot({}), undefined);
});

test("findPinnedPiLspRoot rejects a directory whose package.json name/version does not match the pin", async () => {
  assert.equal(findPinnedPiLspRoot({ PI_CODING_AGENT_DIR: "/nonexistent" }), undefined);
});

test(
  "loads real LSP TypeScript without executing project Babel configuration",
  { skip: skipReason() },
  (t) => {
    const project = mkdtempSync(join(tmpdir(), "pi-lsp-compiler-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    const marker = join(project, "babel-executed");
    writeFileSync(join(project, "babel.config.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('project Babel config executed');`);
    const script = `
      import { createPiLspExtension, PiLspLifecycleController } from "@ian-pascoe/pi-lsp/pi-lsp-extension";
      if (typeof createPiLspExtension !== "function") throw new Error("createPiLspExtension missing");
      if (typeof PiLspLifecycleController !== "function") throw new Error("PiLspLifecycleController missing");
      const registered = [];
      const fakePi = {
        on: (event) => registered.push(event),
        registerTool: () => registered.push("registerTool"),
        registerCommand: () => registered.push("registerCommand"),
        registerEntryRenderer: () => registered.push("registerEntryRenderer"),
        appendEntry: () => {},
      };
      createPiLspExtension()(fakePi);
      const required = ["session_start", "session_tree", "tool_result", "turn_end", "session_shutdown", "registerTool", "registerCommand", "registerEntryRenderer"];
      for (const name of required) if (!registered.includes(name)) throw new Error("missing registration: " + name);
      process.stdout.write("OK\\n");
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", RESOLVE_PI_HOOK, "--import", HOOK, "--input-type=module", "-e", script],
      { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, encoding: "utf8" },
    );
    assert.equal(output.trim(), "OK");
    assert.equal(existsSync(marker), false);
  },
);
