// Runs exclusively inside the sandboxed confined-lsp worker child. Adapts the REAL, unforked
// `@ian-pascoe/pi-lsp` extension (`createPiLspExtension`/`PiLspLifecycleController` from
// pi-lsp-extension.ts, resolved through pi-lsp-module-hook.mjs) to a bidirectional JSON-lines
// RPC channel instead of a live Pi ExtensionAPI: this module registers a FAKE `pi` object whose
// four methods (`on`, `registerTool`, `registerCommand`, `registerEntryRenderer`) the real
// controller calls exactly as it would with the live one, then re-fires those captured
// handlers when the host forwards `session_start`/`session_tree`/`tool_result`/`turn_end`/
// `session_shutdown`, and dispatches captured tool/command calls the same way. No LSP business
// logic -- settings resolution, server spawn, Workspace Edit Preview, diagnostics routing,
// branch replay, command parsing -- is reimplemented here; all of it stays inside the real
// `PiLspLifecycleController`, which only ever sees: a fake ExtensionContext built per call from
// the host-forwarded cwd/projectTrusted/hasUI/branch, and a fake `ui` whose `select`/`notify`
// are reverse RPC calls back to the host's real `ctx.ui`.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiLspExtension } from "@ian-pascoe/pi-lsp/pi-lsp-extension";

/**
 * @param {object} options
 * @param {(method: string, params: unknown) => Promise<unknown>} options.hostRequest Reverse
 *   RPC to the host (ui.select, ui.notify, appendEntry). Only these three bridge calls exist;
 *   everything else the real controller needs lives inside this jailed process already.
 */
export function createConfinedLspWorkerBridge({ hostRequest }) {
  const handlers = new Map();
  let toolDefinition;
  let commandDefinition;
  const entryRenderers = new Map(); // Captured for completeness/tests; never invoked in the
  // worker -- rendering needs the host's live theme/TUI, see extensions/confined-lsp/index.ts.

  /** state mirrors the host's live ExtensionContext fields the real controller reads. */
  const state = { cwd: undefined, projectTrusted: false, hasUI: false, branch: [] };
  let sessionDirPromise;

  function appendEntryBridge(customType, data) {
    // Real `pi.appendEntry` is synchronous/fire-and-forget; preserve that contract, but
    // surface a failed bridge delivery loudly instead of swallowing it silently.
    hostRequest("append_entry", { customType, data }).catch((error) => {
      process.stderr.write(
        `confined-lsp worker: append_entry bridge failed (${customType}): ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool(definition) {
      toolDefinition = definition;
    },
    registerCommand(_name, options) {
      commandDefinition = options;
    },
    registerEntryRenderer(customType, renderer) {
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType, data) {
      state.branch.push({ type: "custom", customType, data });
      appendEntryBridge(customType, data);
    },
  };

  // `getAgentDirectory` is @ian-pascoe/pi-lsp's own test/boundary seam (PiLspLifecycleEffects,
  // the ONLY constructor parameter createPiLspExtension accepts): bind it to the exact trusted
  // root pi-lsp-module-hook.mjs already resolved @ian-pascoe/pi-lsp itself from
  // (PI_CODING_AGENT_DIR), instead of the real @earendil-works/pi-coding-agent getAgentDir()
  // (which resolves from the `pi` binary on PATH and need not match this worker's jail root).
  // Sync registration (PiLspLifecycleController.register() only calls pi.* synchronously).
  createPiLspExtension({ getAgentDirectory: () => process.env.PI_CODING_AGENT_DIR })(pi);

  /** One session-private directory for the life of this worker process, never the real session dir. */
  function sessionDir() {
    sessionDirPromise ??= mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "confined-lsp-session-"));
    return sessionDirPromise;
  }

  function makeUi() {
    return {
      async select(title, options) {
        return /** @type {string | undefined} */ (await hostRequest("ui_select", { title, options }));
      },
      async confirm(title, message) {
        return /** @type {boolean} */ (await hostRequest("ui_confirm", { title, message }));
      },
      async input(title, placeholder) {
        return /** @type {string | undefined} */ (await hostRequest("ui_input", { title, placeholder }));
      },
      notify(message, type) {
        void hostRequest("ui_notify", { message, type: type ?? "info" }).catch((error) => {
          process.stderr.write(
            `confined-lsp worker: ui_notify bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
    };
  }

  async function makeContext(signal) {
    const directory = await sessionDir();
    return {
      cwd: state.cwd,
      hasUI: state.hasUI,
      signal,
      ui: makeUi(),
      sessionManager: {
        getBranch: () => state.branch,
        getSessionDir: () => directory,
      },
      isProjectTrusted: () => state.projectTrusted,
    };
  }

  function applyState(params) {
    state.cwd = process.cwd();
    if (params.projectTrusted !== undefined) state.projectTrusted = params.projectTrusted;
    if (params.hasUI !== undefined) state.hasUI = params.hasUI;
    if (params.branch !== undefined) state.branch = params.branch;
  }

  async function handle(method, params, signal) {
    switch (method) {
      case "session_start": {
        applyState(params);
        await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, await makeContext(signal));
        return {};
      }
      case "session_tree": {
        applyState(params);
        await handlers.get("session_tree")?.({ type: "session_tree", newLeafId: null, oldLeafId: null }, await makeContext(signal));
        return {};
      }
      case "tool": {
        if (toolDefinition === undefined) throw new Error("confined-lsp worker: lsp tool is not registered");
        try {
          const prepared = toolDefinition.prepareArguments ? toolDefinition.prepareArguments(params.input) : params.input;
          return await toolDefinition.execute(params.toolCallId, prepared, signal, undefined, await makeContext(signal));
        } catch (error) {
          // Mirrors the real Pi host's own tool-execution contract (not pi-lsp-specific logic):
          // a thrown ToolDefinition.execute() becomes an error AgentToolResult, not a dropped
          // RPC call -- this worker stands in for that host runtime, so it must do the same.
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            details: undefined,
            isError: true,
          };
        }
      }
      case "tool_result": {
        const handler = handlers.get("tool_result");
        if (handler === undefined) return null;
        const patch = await handler(params.event, await makeContext(signal));
        return patch ?? null;
      }
      case "turn_end": {
        await handlers.get("turn_end")?.(
          { type: "turn_end", turnIndex: 0, message: undefined, toolResults: [], messageEntryId: "", toolResultEntryIds: [] },
          await makeContext(signal),
        );
        return {};
      }
      case "command": {
        if (commandDefinition === undefined) throw new Error("confined-lsp worker: lsp command is not registered");
        applyState(params);
        await commandDefinition.handler(params.args ?? "", await makeContext(signal));
        return {};
      }
      case "command_completions": {
        if (commandDefinition?.getArgumentCompletions === undefined) return null;
        return (await commandDefinition.getArgumentCompletions(params.prefix ?? "")) ?? null;
      }
      case "shutdown": {
        await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, await makeContext(signal));
        return {};
      }
      default:
        throw new Error(`confined-lsp worker: unknown method ${method}`);
    }
  }

  return { handle };
}
