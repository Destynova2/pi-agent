// Confined Pi LSP adapter. Registers the same surface as @ian-pascoe/pi-lsp (the `lsp` tool,
// post-edit diagnostics, the interactive `/lsp` command, model-invisible diagnostics Entries)
// but every operation that can spawn a process, mutate the filesystem, or contact a language
// server runs inside a sandboxed child (extensions/confined-lsp/worker-session.mjs via
// scripts/confined-lsp-worker.mjs), one per Pi session/cwd. The jailed worker runs the REAL,
// unforked @ian-pascoe/pi-lsp extension (createPiLspExtension/PiLspLifecycleController) behind
// a fake ExtensionAPI; this file only wires Pi's real ExtensionAPI to that child over
// lib/rpc-process.ts's bounded, bidirectional JSON-lines RPC, and implements the handful of
// host-only effects the jail cannot perform itself: interactive ui.select/ui.notify/ui.confirm/
// ui.input and appendEntry, answered here as reverse RPC requests from the worker, plus a
// fallback renderer for the model-invisible Post-edit Diagnostics Entry (the worker captures
// @ian-pascoe/pi-lsp's own registerEntryRenderer call, but cannot invoke it itself: rendering
// needs the host's live theme/pi-tui runtime, not something a jailed child can be handed).
import { getAgentDir, withFileMutationQueue, type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildConfinedLspWorkerCommand, buildConfinedLspWorkerEnv, resolveConfinedLspAgentPaths } from "./jail.ts";
import { RpcProcess } from "../../lib/rpc-process.ts";

// Fixed, version-pinned constant: the model-invisible custom entry type
// @ian-pascoe/pi-lsp@0.4.4's lsp-post-edit-diagnostics-rendering.ts registers under. Verified
// against the installed package's own `POST_EDIT_DIAGNOSTICS_ENTRY_TYPE` export (see
// tests/confined-lsp-schema.test.mjs, which snapshot-compares this file's schema/constant
// mirrors against the real installed package and fails loudly on a version drift).
const POST_EDIT_DIAGNOSTICS_ENTRY_TYPE = "pi-lsp-post-edit-diagnostics";

// Hand-mirrored copy of @ian-pascoe/pi-lsp@0.4.4's own `LspToolProviderParametersSchema`
// (lsp-tool-contract.ts): the flat, provider-facing shape Pi registers and the model sees.
// Kept visible here (not a loose passthrough) so a provider-facing contract change is obvious
// in a diff; tests/confined-lsp-schema.test.mjs loads the real schema through the static
// pi-lsp-module-hook.mjs preload hook and asserts JSON-Schema equality against this copy, so a
// silent upstream drift fails a test instead of silently diverging.
const OneBasedPositionSchema = Type.Object({ line: Type.Integer({ minimum: 1 }), character: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const OneBasedRangeSchema = Type.Object({ start: OneBasedPositionSchema, end: OneBasedPositionSchema }, { additionalProperties: false });
const AbsolutePathSchema = Type.String({ minLength: 1, pattern: "^(?:/|[A-Za-z]:[\\\\/])" });
const MutationManifestSchema = Type.Array(
  Type.Union([
    Type.Object({ operation: Type.Literal("create"), path: AbsolutePathSchema }, { additionalProperties: false }),
    Type.Object({ operation: Type.Literal("modify"), path: AbsolutePathSchema }, { additionalProperties: false }),
    Type.Object({ operation: Type.Literal("delete"), path: AbsolutePathSchema }, { additionalProperties: false }),
    Type.Object({ operation: Type.Literal("rename"), path: AbsolutePathSchema, destination_path: AbsolutePathSchema }, { additionalProperties: false }),
  ]),
);
export const LspToolParametersSchema = Type.Object(
  {
    operation: Type.Unsafe<string>({
      type: "string",
      enum: [
        "status", "capabilities", "restart", "diagnostics", "workspace_diagnostics", "completion", "hover",
        "signature_help", "declaration", "goto_definition", "goto_type_definition", "goto_implementation",
        "find_references", "document_highlights", "document_symbols", "workspace_symbols", "document_links",
        "call_hierarchy", "incoming_calls", "outgoing_calls", "type_hierarchy", "supertypes", "subtypes",
        "selection_ranges", "folding_ranges", "code_lenses", "inlay_hints", "document_colors", "format_document",
        "format_range", "format_on_type", "prepare_rename", "rename", "code_actions", "apply",
      ],
    }),
    file_path: Type.Optional(Type.String({ minLength: 1 })),
    server_id: Type.Optional(Type.String({ minLength: 1 })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    character: Type.Optional(Type.Integer({ minimum: 1 })),
    include_declaration: Type.Optional(Type.Boolean()),
    query: Type.Optional(Type.String()),
    positions: Type.Optional(Type.Array(OneBasedPositionSchema, { minItems: 1 })),
    range: Type.Optional(OneBasedRangeSchema),
    trigger_character: Type.Optional(Type.String({ minLength: 1 })),
    new_name: Type.Optional(Type.String({ minLength: 1 })),
    only_kinds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    preview_id: Type.Optional(Type.String({ minLength: 1 })),
    mutation_manifest: Type.Optional(MutationManifestSchema),
    tab_size: Type.Optional(Type.Integer({ minimum: 1 })),
    insert_spaces: Type.Optional(Type.Boolean()),
    trim_trailing_whitespace: Type.Optional(Type.Boolean()),
    insert_final_newline: Type.Optional(Type.Boolean()),
    trim_final_newlines: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

interface ActiveLspSession {
  readonly rpc: RpcProcess;
  readonly cwd: string;
  ready: Promise<void>;
  context: ExtensionContext;
  lifetime: AbortController;
}

/** Plain, JSON-serializable projection of one branch entry: all the worker's replay needs. */
function projectBranchEntry(entry: unknown): Record<string, unknown> | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  if (e.type === "message") {
    const message = e.message as Record<string, unknown> | undefined;
    if (message?.role === "toolResult" && message.toolName === "lsp") {
      // Nested shape on purpose: the worker feeds this straight into @ian-pascoe/pi-lsp's own
      // (unexported) branchLspToolResultDetails reducer, which reads `entry.message.role` etc.
      return { type: "message", message: { role: "toolResult", toolName: "lsp", details: message.details } };
    }
    return undefined;
  }
  if (e.type === "custom" && e.customType === "pi-lsp-enablement") {
    return { type: "custom", customType: "pi-lsp-enablement", data: e.data };
  }
  return undefined;
}

/** Plain-text fallback for the Post-edit Diagnostics Entry: see the module header comment. */
function renderFallbackPostEditDiagnosticsEntry(data: unknown): Component | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const { outcomes } = data as { outcomes?: readonly Record<string, unknown>[] };
  if (!Array.isArray(outcomes) || outcomes.length === 0) return undefined;
  const lines = outcomes
    .map((outcome) => {
      if (!outcome || typeof outcome !== "object") return undefined;
      switch (outcome.kind) {
        case "warning": return `  ${outcome.message}`;
        case "diagnostic": {
          const d = outcome.diagnostic as Record<string, unknown>;
          if (!d || typeof d !== "object") return undefined;
          return `  ${d.path}:${d.line}:${d.character} [${d.serverId}] ${d.message}`;
        }
        case "timeout":
          return `  ${outcome.path}: ${outcome.serverId} timed out`;
        case "unavailable_server":
          return `  ${outcome.path}: ${outcome.serverId} unavailable`;
        case "no_configured_server":
        case "no_diagnostics":
          return undefined;
        default:
          return undefined;
      }
    })
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  // ponytail: plain text, not upstream's rich colored tree (that renderer lives in a module
  // the jailed worker resolves, not the host). Upgrade: statically import
  // "@ian-pascoe/pi-lsp/lsp-post-edit-diagnostics-rendering" host-side if Pi's own extension
  // loader ever supports resolving node_modules TS the way pi-lsp-module-hook.mjs does.
  return new Text(`Pi LSP diagnostics:\n${lines.join("\n")}`);
}

export default function (pi: ExtensionAPI) {
  const paths = resolveConfinedLspAgentPaths(getAgentDir());
  let active: ActiveLspSession | undefined;
  let generation = 0;
  const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().map(projectBranchEntry).filter(e => e !== undefined);

  const stop = () => { generation++; return shutdownActive(); };
  async function shutdownActive(): Promise<void> {
    const previous = active;
    active = undefined;
    if (!previous) return;
    previous.lifetime.abort();
    try { if (previous.rpc.alive) await previous.rpc.request("shutdown", {}, { timeoutMs: 5000 }); }
    catch { /* The supervised shutdown below still verifies process-group cleanup. */ }
    await previous.rpc.shutdown();
  }

  async function current(ctx: ExtensionContext): Promise<ActiveLspSession> {
    if (active?.rpc.alive && active.cwd === ctx.cwd) {
      const session = active;
      session.context = ctx;
      await session.ready;
      if (active !== session) throw new Error("LSP session changed");
      return session;
    }
    const epoch = generation;
    await shutdownActive();
    if (epoch !== generation) throw new Error("LSP session changed");
    if (active) return current(ctx);
    let entry: ActiveLspSession;
    const rpc = new RpcProcess({
      command: paths.shellLauncherPath,
      args: ["--offline", "-c", buildConfinedLspWorkerCommand(paths)],
      cwd: ctx.cwd, env: buildConfinedLspWorkerEnv(paths),
      onStderr: chunk => { if (active === entry && !entry.context.hasUI) process.stderr.write(chunk); },
      async onRequest(method, value) {
        if (active !== entry) throw new Error("LSP session changed");
        const context = entry.context;
        const params = value as Record<string, unknown>;
        switch (method) {
          case "ui_select": {
            if (!context.hasUI || !Array.isArray(params.options) || !params.options.every(item => typeof item === "string")) return null;
            const result = await context.ui.select(String(params.title), params.options, { signal: entry.lifetime.signal });
            if (active !== entry) throw new Error("LSP session changed");
            return result ?? null;
          }
          case "ui_notify":
            context.ui.notify(String(params.message), params.type === "error" ? "error" : params.type === "warning" ? "warning" : "info");
            return null;
          case "append_entry":
            if (!["pi-lsp-enablement", POST_EDIT_DIAGNOSTICS_ENTRY_TYPE].includes(String(params.customType))) throw new Error("Unsupported LSP entry type");
            pi.appendEntry(String(params.customType), params.data);
            return null;
          default: throw new Error(`Unsupported LSP host request: ${method}`);
        }
      },
    });
    rpc.start();
    entry = { rpc, cwd: ctx.cwd, context: ctx, ready: Promise.resolve(), lifetime: new AbortController() };
    active = entry;
    entry.ready = rpc.request("session_start", {
      cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), hasUI: ctx.hasUI, branch: branch(ctx),
    }).then(() => {});
    try { await entry.ready; }
    catch (error) { if (active === entry) active = undefined; await rpc.shutdown(); throw error; }
    return entry;
  }

  pi.on("session_start", async (_event, ctx) => { await stop(); await current(ctx); });
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_shutdown", stop);
  pi.on("session_tree", async (_event, ctx) => { await stop(); await current(ctx); });
  pi.on("turn_end", async (_event, ctx) => {
    const session = active;
    if (session?.rpc.alive && session.cwd === ctx.cwd) {
      session.context = ctx;
      await session.ready;
      if (active === session) await session.rpc.request("turn_end", {});
    }
  });
  pi.registerEntryRenderer(POST_EDIT_DIAGNOSTICS_ENTRY_TYPE, entry => renderFallbackPostEditDiagnosticsEntry(entry.data));
  pi.registerTool({
    name: "lsp", label: "LSP (confined)",
    description: "Query language servers and create/apply guarded Workspace Edit Previews inside Codex. Paths may start with @; lines/characters are one-based. Required fields: status: none; capabilities/restart/workspace_diagnostics: server_id,file_path; diagnostics/document_symbols/document_links/folding_ranges/code_lenses/document_colors: file_path; workspace_symbols: query,file_path; selection_ranges: file_path,positions; inlay_hints/code_actions: file_path,range; format_document: file_path,tab_size,insert_spaces; format_range: file_path,range,tab_size,insert_spaces; format_on_type: file_path,line,character,trigger_character,tab_size,insert_spaces; rename: file_path,line,character,new_name; apply: preview_id; other navigation operations: file_path,line,character. Output is bounded with spill files. Mutations require a preview then apply.",
    promptSnippet: "Language-server navigation, diagnostics and preview/apply mutations inside Codex",
    promptGuidelines: ["Use lsp read operations for semantic navigation and diagnostics; preview mutations before applying them."],
    parameters: LspToolParametersSchema,
    executionMode: "sequential",
    async execute(toolCallId, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const session = await current(ctx);
      const run = async () => await session.rpc.request("tool", { toolCallId, input }, { signal }) as AgentToolResult;
      return input.operation === "apply" ? withFileMutationQueue(ctx.cwd, run) : run();
    },
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const session = active;
    if (!session?.rpc.alive || session.cwd !== ctx.cwd) return;
    session.context = ctx;
    await session.ready;
    if (active !== session) return;
    try {
      return await session.rpc.request("tool_result", { event }, { signal: ctx.signal }) as
        { content: ToolResultEvent["content"]; details: ToolResultEvent["details"]; isError: boolean } | undefined;
    } catch (error) {
      if (active === session) ctx.ui.notify(`LSP diagnostics unavailable: ${String(error)}`, "warning");
    }
  });
  pi.registerCommand("lsp", {
    description: "Manage confined language servers (interactive picker or explicit arguments)",
    getArgumentCompletions: async prefix => {
      if (!active?.rpc.alive) return null;
      return await active.rpc.request("command_completions", { prefix }) as { value: string; label: string; description?: string }[] | null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const session = await current(ctx);
        await session.rpc.request("command", { args, hasUI: ctx.hasUI, projectTrusted: ctx.isProjectTrusted() }, { signal: ctx.signal });
      } catch (error) { ctx.ui.notify(`Confined LSP: ${String(error)}`, "error"); }
    },
  });
}
