#!/usr/bin/env node
// Minimal real LSP server over stdio Content-Length framing, using the actual installed
// vscode-languageserver-protocol wire format (the same library @ian-pascoe/pi-lsp's
// LspServerClient speaks), so tests exercise the real protocol client, not a stub transport.
//
// Behaviour, selected by env vars so one fixture covers every scenario the task asks for:
// - FAKE_LSP_FAIL_STARTUP=1: exit(1) before replying to `initialize` (failed startup).
// - FAKE_LSP_HANG_INITIALIZE=1: never reply to `initialize` (for cancellation/timeout tests).
// - otherwise: replies to initialize with hover+applyEdit capability, answers
//   textDocument/hover with a fixed result (read request), and on a custom
//   `pi/triggerApplyEdit` request sends the client a real workspace/applyEdit request whose
//   edit rewrites the given file (preview/apply flow). Replies to shutdown/exit normally.
// Not a repo dependency: resolved by absolute path from the same trusted agent npm root
// the worker uses (PI_CODING_AGENT_DIR), exactly like worker-session.mjs does -- no new
// package.json dependency for a test-only fixture.
import { join } from "node:path";
import { createRequire } from "node:module";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("fake-lsp-server: PI_CODING_AGENT_DIR is required");
const {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  HoverRequest,
  ShutdownRequest,
  ExitNotification,
  ApplyWorkspaceEditRequest,
  DocumentDiagnosticRequest,
} = createRequire(join(agentDir, "npm/package.json"))("vscode-languageserver-protocol/node");

if (process.env.FAKE_LSP_FAIL_STARTUP === "1") {
  process.stderr.write("fake-lsp-server: simulated startup failure\n");
  process.exit(1);
}

const connection = createProtocolConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

connection.onRequest(InitializeRequest.type, async () => {
  if (process.env.FAKE_LSP_HANG_INITIALIZE === "1") {
    await new Promise(() => {}); // Never resolves: exercises the client's own initialize timeout.
  }
  return {
    capabilities: {
      hoverProvider: true,
      textDocumentSync: 1,
      diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    },
  };
});

let appliedEditTriggered = false;
connection.onRequest(HoverRequest.type, async (params, _token, _workDone, _resultToken, info) => {
  // Fire a real server-initiated workspace/applyEdit once, asynchronously, the same way a
  // language server proposes a fix after answering an unrelated request. The client (the real
  // LspServerClient) turns this into a Workspace Edit Preview, never writing the file itself.
  if (process.env.FAKE_LSP_TRIGGER_APPLY_EDIT === "1" && !appliedEditTriggered) {
    appliedEditTriggered = true;
    const uri = process.env.FAKE_LSP_TARGET_URI_OVERRIDE ?? params.textDocument.uri;
    setTimeout(() => {
      connection
        .sendRequest(ApplyWorkspaceEditRequest.type, {
          label: "fake edit",
          edit: {
            changes: {
              [uri]: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "// edited\n",
                },
              ],
            },
          },
        })
        .catch(() => {});
    }, 10);
  }
  return {
    contents: { kind: "plaintext", value: `fake hover at ${params.position.line}:${params.position.character}` },
  };
});

connection.onRequest(DocumentDiagnosticRequest.type, async () => ({ kind: "full", items: [{
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1, message: "fixture diagnostic",
}] }));
connection.onRequest(ShutdownRequest.type, async () => null);
connection.onNotification(ExitNotification.type, () => process.exit(0));

connection.listen();
