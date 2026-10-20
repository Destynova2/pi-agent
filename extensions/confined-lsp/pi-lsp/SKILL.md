---
name: pi-lsp
description: Diagnose or configure confined Pi language servers when a file does not route, diagnostics are missing, or server startup fails.
disable-model-invocation: true
---

# Confined Pi LSP

This installation exposes one `lsp` tool. Select upstream operations with its
`operation` argument; for example, `{"operation":"status","all":true}`.
If `lsp` is dormant, activate it with `load_tools` and `{"tools":["lsp"]}`.
The upstream `lsp_status`, `lsp_capabilities` and other separate tools are not
registered here. Keep the upstream package's extension and skill filters empty.

Inspect full status with `all: true`, then query `capabilities` and `diagnostics`
for a representative `file_path`, adding `server_id` when needed. Locations are
one-based. `completion` accepts `prefix` and `limit`; `document_symbols` accepts
`depth`; `workspace_symbols` accepts `limit`.

Distinguish a routing/configuration problem from a process or capability failure.
`configured` means no file has routed yet; `stopped` allows lazy startup;
`disabled` prevents startup. An `unavailable` instance retains its startup error.
A silent push-only server can mean a clean file; a stalled pull request does not.
Use `/lsp` to inspect or change session enablement, and restart a server only when
the current task authorizes it. Settings changes require a reload.

The worker reads protected global settings and runs servers in the sandbox.
Project configuration cannot grant host execution. If a required path or runtime
is denied, report the exact boundary and use an available scoped access mechanism.
Do not enable upstream host hooks or switch to a host shell to recover.

Mutations produce a Workspace Edit Preview; apply its `preview_id` only within
the authorized task. Finish by verifying the representative operation and any
requested edit. A successful status query alone does not prove a server works.
