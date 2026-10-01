// Drives the REAL stack end to end: scripts/codex-shell.mjs (Codex OS sandbox) spawning
// `node scripts/confined-lsp-worker.mjs` (via jail.ts's own command string: plain node, no
// Bun), against the real installed @ian-pascoe/pi-lsp and a fake stdio LSP server, to prove the
// one guarantee that cannot be proven by running the worker directly
// (tests/confined-lsp-worker.test.mjs, which bypasses codex-shell.mjs on purpose): a Workspace
// Edit whose target resolves OUTSIDE the sandboxed project directory must be denied by the OS
// sandbox itself, not by application logic.
//
// Run on a host where Codex can create its sandbox and private cache. An enclosing sandbox
// can deny either operation; that failure must fail the test, not trigger a skip or an
// unrestricted retry. The default test runner excludes .integration.test.mjs files.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../lib/rpc-process.ts";
import { buildConfinedLspWorkerCommand, buildConfinedLspWorkerEnv, resolveConfinedLspAgentPaths } from "../extensions/confined-lsp/jail.ts";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const REAL_AGENT_DIR = getAgentDir();
const FIXTURE = resolve(REPO_DIR, "tests/confined-lsp-fixtures/fake-lsp-server.mjs");
const paths = resolveConfinedLspAgentPaths(REAL_AGENT_DIR, new URL("../extensions/confined-lsp/jail.ts", import.meta.url).href);

function isolatedAgentDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(REAL_AGENT_DIR, "npm"), join(dir, "npm"));
  return dir;
}

test(
  "confined-lsp worker under the real Codex sandbox: an edit outside the project is denied",
  { timeout: 60000 },
  async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), "confined-lsp-sandbox-project-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "confined-lsp-sandbox-outside-"));
    const agentDir = isolatedAgentDir("confined-lsp-sandbox-agent-");
    t.after(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    const insideTarget = join(projectDir, "a.txt");
    const outsideTarget = join(outsideDir, "outside.txt");
    writeFileSync(insideTarget, "original\n");
    writeFileSync(outsideTarget, "untouched\n");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify(
        {
          lsp: {
            servers: {
              fake: {
                command: process.execPath,
                args: [FIXTURE],
                environment: {
                  PI_CODING_AGENT_DIR: REAL_AGENT_DIR,
                  FAKE_LSP_TRIGGER_APPLY_EDIT: "1",
                  FAKE_LSP_TARGET_URI_OVERRIDE: `file://${outsideTarget}`,
                },
                languages: [{ extensions: [".txt"], languageId: "plaintext" }],
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const sandboxPaths = { ...paths, agentDir };
    const rpc = new RpcProcess({
      command: sandboxPaths.shellLauncherPath,
      args: ["--offline", "-c", buildConfinedLspWorkerCommand(sandboxPaths)],
      cwd: projectDir,
      env: buildConfinedLspWorkerEnv(sandboxPaths),
      requestTimeoutMs: 20000,
      onRequest: async () => null,
    });
    rpc.start();
    try {
      await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
      const warm = await rpc.request("tool", { toolCallId: "warm", input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 } });
      assert.notEqual(warm.isError, true, JSON.stringify(warm));
      let previewId;
      for (let attempt = 0; attempt < 20 && previewId === undefined; attempt += 1) {
        const status = await rpc.request("tool", { toolCallId: `status-${attempt}`, input: { operation: "status" } });
        previewId = status.details?.preview_records?.[0]?.preview_id;
        if (previewId === undefined) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(previewId, "a Workspace Edit Preview for the outside path must still be created");
      const applied = await rpc.request("tool", { toolCallId: "apply1", input: { operation: "apply", preview_id: previewId } });
      assert.equal(applied.isError, true, "applying an edit outside the sandboxed project must fail");
      assert.equal(readFileSync(outsideTarget, "utf8"), "untouched\n", "the OS sandbox must have denied the write, not just the app");
    } finally {
      await rpc.shutdown();
    }
  },
);
