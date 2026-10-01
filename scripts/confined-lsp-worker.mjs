#!/usr/bin/env node
// Persistent child for extensions/confined-lsp: one process per Pi session/cwd, launched
// through <repoRoot>/scripts/codex-shell.mjs so every language-server spawn, Workspace Edit
// Preview apply/rollback, post-edit diagnostics run, and /lsp command executes inside the
// sandbox. Bounded, bidirectional newline-delimited JSON-RPC over inherited stdin/stdout,
// wire-compatible with lib/rpc-process.ts's RpcProcess (the host side): forward requests from
// the host carry `method`+`id` and get a `{id,result}`/`{id,error}` reply; this worker's own
// reverse requests to the host (ui.select/ui.notify/appendEntry, see worker-session.mjs) carry
// `method`+a worker-local `id` and are resolved by the host's own RpcProcess.onRequest.
//
// No model or provider calls; this process only drives @ian-pascoe/pi-lsp's own implementation
// (extensions/confined-lsp/worker-session.mjs), never a second agent loop. Run under plain
// `node` (`--import` flags set by extensions/confined-lsp/jail.ts register the static resolve
// hooks that make the installed source-only @ian-pascoe/pi-lsp package loadable without Bun).
//
// Per lib/rpc-process.ts: the host never sends a per-request "cancel" message -- a timed-out or
// aborted host request kills this whole process (and the sandbox supervises the exit). This
// worker therefore does not track per-request cancellation itself; it only aborts its one
// process-wide AbortController on SIGTERM/SIGINT so an in-flight language-server call unwinds
// before the process exits.
import { createInterface } from "node:readline";
import { createConfinedLspWorkerBridge } from "../extensions/confined-lsp/worker-session.mjs";

if (!process.env.CODEX_SANDBOX) throw new Error("LSP worker requires the Codex sandbox");
const MAX_LINE_BYTES = 8 * 1024 * 1024;

const shutdownController = new AbortController();
let nextHostRequestId = 0;
const pendingHostRequests = new Map();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Reverse RPC to the host: a request this worker initiates (ui.select, ui.notify, appendEntry). */
function hostRequest(method, params) {
  const id = ++nextHostRequestId;
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject });
    writeMessage({ jsonrpc: "2.0", id, method, params });
  });
}

const bridge = createConfinedLspWorkerBridge({ hostRequest });

async function handleForwardRequest(message) {
  const { id, method, params = {} } = message;
  try {
    const result = await bridge.handle(method, params, shutdownController.signal);
    if (id !== undefined) writeMessage({ jsonrpc: "2.0", id, result: result ?? null });
    if (method === "shutdown") {
      process.exitCode = 0;
      process.exit(0);
    }
  } catch (error) {
    if (id !== undefined) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

function handleHostResponse(message) {
  const pending = pendingHostRequests.get(message.id);
  if (pending === undefined) return;
  pendingHostRequests.delete(message.id);
  if (message.error !== undefined) {
    pending.reject(new Error(typeof message.error === "string" ? message.error : (message.error.message ?? JSON.stringify(message.error))));
  } else {
    pending.resolve(message.result);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    process.stderr.write("confined-lsp worker: request exceeded bounded size limit\n");
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("confined-lsp worker: malformed request line ignored\n");
    return;
  }
  if (typeof message.method === "string") void handleForwardRequest(message);
  else handleHostResponse(message);
});

async function shutdownOnSignal() {
  shutdownController.abort();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdownOnSignal());
process.once("SIGINT", () => void shutdownOnSignal());
