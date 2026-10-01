// Snapshot-compares extensions/confined-lsp/index.ts's hand-mirrored `LspToolParametersSchema`
// (the one Pi actually registers for the `lsp` tool) against the REAL, installed
// @ian-pascoe/pi-lsp@0.4.4 `LspToolProviderParametersSchema` (lsp-tool-contract.ts), loaded
// through the same static pi-lsp-module-hook.mjs preload hook the worker uses. A silent
// provider-facing contract drift (a field added/removed/retyped upstream) fails this test
// instead of silently diverging from what the model is actually allowed to send.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LspToolParametersSchema } from "../extensions/confined-lsp/index.ts";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = getAgentDir();
const HOOK = join(REPO_DIR, "extensions/confined-lsp/pi-lsp-module-hook.mjs");
const RESOLVE_PI_HOOK = join(REPO_DIR, "lib/resolve-pi.mjs");
const PI_LSP_INSTALLED = existsSync(join(AGENT_DIR, "npm/node_modules/@ian-pascoe/pi-lsp/src/lsp-tool-contract.ts"));

test(
  "the registered tool schema is exactly the real upstream provider-facing schema",
  { skip: PI_LSP_INSTALLED ? undefined : `@ian-pascoe/pi-lsp is not installed under ${AGENT_DIR}` },
  () => {
    const script = `
      import { LspToolProviderParametersSchema } from "@ian-pascoe/pi-lsp/lsp-tool-contract";
      process.stdout.write(JSON.stringify(LspToolProviderParametersSchema));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", RESOLVE_PI_HOOK, "--import", HOOK, "--input-type=module", "-e", script],
      { env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, encoding: "utf8" },
    );
    const upstream = JSON.parse(output);
    const mirrored = JSON.parse(JSON.stringify(LspToolParametersSchema));
    assert.deepEqual(
      mirrored,
      upstream,
      "extensions/confined-lsp/index.ts's LspToolParametersSchema drifted from @ian-pascoe/pi-lsp's real LspToolProviderParametersSchema -- update the hand-mirrored copy",
    );
  },
);
