// Runs the REAL scripts/confined-lsp-worker.mjs under plain `node` (no Bun, no sandbox --
// that layer is covered separately by tests/confined-lsp-sandbox.integration.test.mjs and by
// the repo's existing tests/codex-shell.test.mjs), driving the actual installed
// @ian-pascoe/pi-lsp 0.4.4 against a fake stdio LSP server that speaks the real
// vscode-languageserver-protocol wire format. Proves: read request, Workspace Edit
// Preview/apply inside the workspace, session reconstruction (preview replay against a fresh
// worker via a real "session_start" branch, exactly how @ian-pascoe/pi-lsp's own
// PiLspLifecycleController.startSession replays it), shutdown, failed startup, and
// cancellation -- without ever writing inside a real private workspace (every fixture runs in
// a throwaway tmp project) and without ever touching the real global ~/.pi/agent/settings.json
// (each test gets its own isolated agent dir: a settings.json this test writes, and a `npm`
// symlink to the real installed modules root -- "tests set actual isolated agent settings file
// and installed modules resolver", not a worker-side settingsOverride trust-boundary bypass).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../lib/rpc-process.ts";
import { resolveConfinedLspAgentPaths } from "../extensions/confined-lsp/jail.ts";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const REAL_AGENT_DIR = getAgentDir();
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "confined-lsp-fixtures/fake-lsp-server.mjs");
const paths = resolveConfinedLspAgentPaths(REAL_AGENT_DIR, new URL("../extensions/confined-lsp/jail.ts", import.meta.url).href);
const PI_LSP_INSTALLED = existsSync(join(REAL_AGENT_DIR, "npm/node_modules/@ian-pascoe/pi-lsp/src/pi-lsp-extension.ts"));

function skipReason() {
  return PI_LSP_INSTALLED ? undefined : `@ian-pascoe/pi-lsp is not installed under ${REAL_AGENT_DIR}/npm/node_modules`;
}

/** An isolated agent dir: this test's own settings.json, the REAL installed npm root. */
function isolatedAgentDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(REAL_AGENT_DIR, "npm"), join(dir, "npm"));
  return dir;
}

function writeFakeServerSettings(agentDir, extraEnv = {}) {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        lsp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [FIXTURE],
              environment: { PI_CODING_AGENT_DIR: REAL_AGENT_DIR, ...extraEnv },
              languages: [{ extensions: [".txt"], languageId: "plaintext" }],
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function tmpProject(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function worker(cwd, agentDir, { onRequest } = {}) {
  const notifications = [];
  return {
    notifications,
    rpc: new RpcProcess({
      command: process.execPath,
      args: ["--import", paths.resolvePiHookPath, "--import", paths.piLspModuleHookPath, paths.workerPath],
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, CODEX_SANDBOX: "unit-test-only" },
      requestTimeoutMs: 15000,
      onRequest:
        onRequest ??
        (async (method, params) => {
          if (method === "ui_notify") {
            notifications.push(params);
            return null;
          }
          if (method === "append_entry") return null;
          if (method === "ui_select") return undefined;
          throw new Error(`test worker harness: unsupported bridge request ${method}`);
        }),
    }),
  };
}

test("confined-lsp worker: read request (hover) against a real fake LSP server", { skip: skipReason() }, async (t) => {
  const projectDir = tmpProject("confined-lsp-read-");
  const agentDir = isolatedAgentDir("confined-lsp-read-agent-");
  t.after(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  writeFileSync(join(projectDir, "a.txt"), "hello\n");
  writeFakeServerSettings(agentDir);

  const { rpc } = worker(projectDir, agentDir);
  rpc.start();
  try {
    await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
    const result = await rpc.request("tool", {
      toolCallId: "t1",
      input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /fake hover at 0:0/);
  } finally {
    await rpc.shutdown();
  }
});

async function createPreviewViaServerInitiatedEdit(rpc) {
  await rpc.request("tool", {
    toolCallId: "warm",
    input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 },
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await rpc.request("tool", { toolCallId: `status-${attempt}`, input: { operation: "status" } });
    const previewId = status.details?.preview_records?.[0]?.preview_id;
    if (previewId !== undefined) return { previewId, details: status.details };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("server-initiated Workspace Edit Preview never arrived");
}

test(
  "confined-lsp worker: Workspace Edit Preview + apply mutates the file inside the workspace",
  { skip: skipReason() },
  async (t) => {
    const projectDir = tmpProject("confined-lsp-apply-");
    const agentDir = isolatedAgentDir("confined-lsp-apply-agent-");
    t.after(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    const target = join(projectDir, "a.txt");
    writeFileSync(target, "original\n");
    writeFakeServerSettings(agentDir, { FAKE_LSP_TRIGGER_APPLY_EDIT: "1" });

    const { rpc } = worker(projectDir, agentDir);
    rpc.start();
    try {
      await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
      const { previewId } = await createPreviewViaServerInitiatedEdit(rpc);
      assert.equal(readFileSync(target, "utf8"), "original\n", "a preview must not touch the file before apply");

      const applied = await rpc.request("tool", {
        toolCallId: "apply1",
        input: { operation: "apply", preview_id: previewId },
      });
      assert.notEqual(applied.isError, true, JSON.stringify(applied));
      assert.match(readFileSync(target, "utf8"), /^\/\/ edited\noriginal\n$/);
    } finally {
      await rpc.shutdown();
    }
  },
);

test(
  "confined-lsp worker: session reconstruction replays a known preview_id in a fresh worker's session_start",
  { skip: skipReason() },
  async (t) => {
    const projectDir = tmpProject("confined-lsp-restore-");
    const agentDir = isolatedAgentDir("confined-lsp-restore-agent-");
    t.after(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    writeFileSync(join(projectDir, "a.txt"), "original\n");
    writeFakeServerSettings(agentDir, { FAKE_LSP_TRIGGER_APPLY_EDIT: "1" });

    const first = worker(projectDir, agentDir);
    first.rpc.start();
    let previewId;
    let previewDetails;
    try {
      await first.rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
      const preview = await createPreviewViaServerInitiatedEdit(first.rpc);
      previewId = preview.previewId;
      previewDetails = preview.details;
    } finally {
      await first.rpc.shutdown();
    }

    // Simulate navigating/forking to a fresh session: a brand-new worker, fed only the plain
    // branch data a host would read from ctx.sessionManager.getBranch() (the original tool
    // result's `details`) on "session_start", must recognize the same preview_id as available
    // before any language server has even been asked to start again -- exactly
    // PiLspLifecycleController.startSession's own replayPreviewRecords call, not a
    // reimplementation of it.
    const second = worker(projectDir, agentDir);
    second.rpc.start();
    try {
      await second.rpc.request("session_start", {
        cwd: projectDir,
        projectTrusted: true,
        hasUI: false,
        branch: [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "lsp",
              details: previewDetails,
            },
          },
        ],
      });
      assert.deepEqual(second.notifications, [], "a valid replayed record must not produce an 'ignored invalid record' warning");
      const applied = await second.rpc.request("tool", {
        toolCallId: "apply-after-restore",
        input: { operation: "apply", preview_id: previewId },
      });
      assert.notEqual(applied.isError, true, JSON.stringify(applied));
      assert.equal(readFileSync(join(projectDir, "a.txt"), "utf8"), "// edited\noriginal\n");
    } finally {
      await second.rpc.shutdown();
    }
  },
);

test("confined-lsp worker: a failed server startup surfaces as a tool error, not a crash", { skip: skipReason() }, async (t) => {
  const projectDir = tmpProject("confined-lsp-failstart-");
  const agentDir = isolatedAgentDir("confined-lsp-failstart-agent-");
  t.after(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  writeFileSync(join(projectDir, "a.txt"), "hello\n");
  writeFakeServerSettings(agentDir, { FAKE_LSP_FAIL_STARTUP: "1" });

  const { rpc } = worker(projectDir, agentDir);
  rpc.start();
  try {
    await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
    const result = await rpc.request("tool", {
      toolCallId: "t1",
      input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 },
    });
    assert.equal(result.isError, true);
  } finally {
    await rpc.shutdown();
  }
});

test(
  "confined-lsp worker: a canceled request kills the worker instead of hanging on a stuck server",
  { skip: skipReason() },
  async (t) => {
    const projectDir = tmpProject("confined-lsp-cancel-");
    const agentDir = isolatedAgentDir("confined-lsp-cancel-agent-");
    t.after(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });
    writeFileSync(join(projectDir, "a.txt"), "hello\n");
    writeFakeServerSettings(agentDir, { FAKE_LSP_HANG_INITIALIZE: "1" });

    const { rpc } = worker(projectDir, agentDir);
    rpc.start();
    await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
    const controller = new AbortController();
    const pending = rpc.request(
      "tool",
      { toolCallId: "t1", input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 } },
      { signal: controller.signal, timeoutMs: 30000 },
    );
    setTimeout(() => controller.abort(), 200);
    // lib/rpc-process.ts stops the whole supervised process group on a canceled request
    // rather than sending a per-request cancel notification (see scripts/confined-lsp-worker.mjs's
    // module header): the pending call must reject, not hang.
    await assert.rejects(() => pending, /canceled/);
  },
);

test("confined-lsp worker: shutdown stops the server and the worker exits cleanly", { skip: skipReason() }, async (t) => {
  const projectDir = tmpProject("confined-lsp-shutdown-");
  const agentDir = isolatedAgentDir("confined-lsp-shutdown-agent-");
  t.after(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  writeFileSync(join(projectDir, "a.txt"), "hello\n");
  writeFakeServerSettings(agentDir);

  const { rpc } = worker(projectDir, agentDir);
  rpc.start();
  await rpc.request("session_start", { cwd: projectDir, projectTrusted: true, hasUI: false, branch: [] });
  await rpc.request("tool", { toolCallId: "t1", input: { operation: "hover", file_path: "a.txt", line: 1, character: 1 } });
  const start = Date.now();
  await rpc.request("shutdown", {});
  await rpc.shutdown();
  assert.ok(Date.now() - start < 8000, "graceful shutdown must not wait out a forced-kill timeout");
});
