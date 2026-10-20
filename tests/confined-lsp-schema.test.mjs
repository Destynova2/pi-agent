// Compare the stable `lsp` host surface with the union of the installed upstream
// operation schemas. Each worker operation still enforces its exact required fields.
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
  "the confined compatibility schema preserves every upstream operation and field constraint",
  { skip: PI_LSP_INSTALLED ? undefined : `@ian-pascoe/pi-lsp is not installed under ${AGENT_DIR}` },
  () => {
    const script = `
      import { LSP_OPERATION_NAMES, LspOperationParametersSchemas } from "@ian-pascoe/pi-lsp/lsp-tool-contract";
      process.stdout.write(JSON.stringify({ operations: LSP_OPERATION_NAMES, schemas: LspOperationParametersSchemas }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", RESOLVE_PI_HOOK, "--import", HOOK, "--input-type=module", "-e", script],
      { env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, encoding: "utf8" },
    );
    const upstream = JSON.parse(output);
    const stripDescriptions = value => JSON.parse(JSON.stringify(value, (key, item) => key === "description" ? undefined : item));
    const mirrored = stripDescriptions(LspToolParametersSchema);
    const properties = { operation: { type: "string", enum: upstream.operations } };
    for (const schema of Object.values(upstream.schemas)) {
      for (const [key, value] of Object.entries(schema.properties)) {
        const field = stripDescriptions(value);
        if (key in properties) assert.deepEqual(properties[key], field, `inconsistent upstream field: ${key}`);
        properties[key] = field;
      }
    }
    assert.deepEqual(
      mirrored,
      { type: "object", properties, required: ["operation"], additionalProperties: false },
      "confined LSP parameters drifted from the installed upstream operations",
    );
  },
);
