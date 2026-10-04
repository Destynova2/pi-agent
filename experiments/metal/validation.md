# Native validation record

Observed 2026-10-04 on Apple M5 Max, macOS 26.5.1 (Darwin 25.5.0), arm64,
Node 26.10.0, Pi SDK 1.0.2, Codex release 0.160.0 with the adjacent patch.
This is a test summary, not an installable qualification receipt.

Qualified binary SHA-256:
`0749345ac69991649ea1c8edd3fc631eb3687c70d737b1d8cb6809bcd814495f`.

| Check | Result |
| --- | --- |
| Swift compilation inside ordinary Codex sandbox | Passed |
| Actual Metal compute in candidate sandbox | `METAL_COMPUTE_OK [2.0, 4.0, 6.0, 8.0]` |
| Ordinary Metal before and after the approved command | `METAL_UNAVAILABLE`, exit 77 |
| Workspace write / outside write / `.git` write | Allowed / denied / denied |
| Direct TCP to reachable local control | Denied with EPERM/EACCES |
| Managed proxy: github.com allowed, example.com forbidden | Passed, forbidden host returns 403 |
| Timeout and cancellation after child readiness | Parent and descendant reaped |
| Real Pi broker: command, digest, single use, result journal | Passed |
| Real Pi launcher: file policy and ordinary GPU denial | Passed |
| Nested launcher upgrade attempted from ordinary sandbox | Denied |
| Pi session navigation during approved command | Canceled; descendant reaped; result logged |
| Missing, altered, linked or incomplete backend configuration | Refused before execution |
| Backend replacement during the confirmation dialog | Refused |

Validation commands and limits:

- `qualify.mjs`: ten native checks passed. `validate-pi.mjs`: ten integration checks
  passed. These are real native executions, with an automated test confirmation UI.
- Focused JS unit/installer/preparation suite: 33 passed, no skips.
- Existing file-grant, managed-network and strict-tool native regressions: eight
  passed, no skips.
- `node scripts/check.mjs`: clean.
- Standard Pi suite: 192/200 passed; eight existing LSP tests fail because Node 26
  rejects `stripTypeScriptTypes({mode:"transform"})` in the unchanged LSP hook.
- Codex CLI/chatgpt crate suite: 507/508 passed, one skipped, two passed on retry.
  `packaged_daemon_bootstrap_seeds_local_package` fails its updater-state assertion
  in `cli/tests/app_server_daemon.rs:667`. No daemon code is changed by this patch;
  the failure has not been independently reproduced on an unpatched build.
- All three added Rust Metal tests passed; required `just fmt` passed.

Only this Mac/OS combination is qualified. General workloads (Blender, MLX,
long-running training), Intel Macs, other Apple GPU generations and production
installation/restart have not been qualified. The branch remains a review draft;
passing these tests does not establish an independently reviewed security boundary.
