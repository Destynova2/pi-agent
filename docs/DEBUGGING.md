# Bounded diagnostics

## Exact user URL reads without redundant host approval

Installed on 2026-10-05. The reported Reddit invocation appended `.json` to the
user's URL, failed with HTTP 403 and was classified as authentication before a
session-wide host grant was requested. HTTP 403 alone did not establish that
credentials were needed. The old network prompt also included uploads and all
ports; it was broader than the requested page read.

The web extension now captures exact public URLs from direct interactive/RPC
input. Its fixed GET worker runs in Codex with only the requested destination,
no cookies, request bodies, curl configuration, custom ports or redirects.
Explicit host denies win. URLs from pages, extension messages and child agents
cannot create this consent; path/query changes do not inherit it. No grant file
or Bash permission is created. Reload/navigation clears the URL consent cache.

Thirty-three focused tests and five HTTP/native tests passed. The native checks
verify no dialog, ordinary Bash denial before/after the read, command injection
and nested-upgrade rejection, outside-write denial and explicit host denial.
A fresh real Pi process then read example.com through `/web` without a model
call or approval prompt. All ten installed Metal broker checks also passed.
The Reddit GET itself exited successfully but yielded only six extracted text
characters; that is not proof that the article content was retrieved.

Backup, file digests and runtime verification:
`/Users/ludwig/.pi/web-read-deployment-2026-10-05T06-18-57Z/`.
The running interactive sessions were not reloaded by the verification process.

## Installed one-command Metal capability

On 2026-10-04, [PR #1](https://github.com/Destynova2/pi-agent/pull/1) and
[PR #2](https://github.com/Destynova2/pi-agent/pull/2) were merged into
`feat/confined-tools` and installed after explicit operator approval. The merged
revision is `aaeedba93bd3126afd0c1ac1278467ce23652a81`.

The optional backend is installed at
`~/.pi/agent/backends/metal/codex`, with a qualification report and a SHA-256-bound
`~/.pi/agent/metal-backend.json` manifest. Its digest is
`0749345ac69991649ea1c8edd3fc631eb3687c70d737b1d8cb6809bcd814495f`.
An eligible failed foreground Bash call can request `gpu: "metal"` through
`request_command_access`. The exact command needs confirmation, has a 60-second
deadline, and records its result. This is an experimental Pi capability; the
ordinary Codex backend and ordinary command permissions remain unchanged.

All ten backend checks and ten Pi integration checks passed again against the
installed files: actual compute, file/network restrictions, managed proxy policy,
single use, result journal, cancellation, timeout, nested-upgrade denial and
ordinary GPU denial. A fresh Pi RPC process loaded the installed configuration
and reported the Metal capability through `/confined-tools`, without a model call.
The LSP Node 26 correction is installed as well. Existing MCP settings, Podman
host operations and task-progress support were preserved.

Backups and post-install evidence:

- `/Users/ludwig/.pi/metal-deployment-2026-10-04T20-40-57.119Z/`
- `/Users/ludwig/.pi/agent.backup-2026-10-04T20-40-57-392Z/`

The existing interactive iTerm sessions were not restarted: the computer-control
tool refused access to iTerm. They need a normal quit and `pi --continue` to load
the new tool definition. The new validation process was closed after verification.
The diagnosis below records the original stock-backend failure, which still
applies to ordinary commands without the explicit Metal grant.

## Session pi-11036: ordinary Bash was mistaken for a Metal retry

The session log at 2026-10-04 21:39–21:40 UTC shows the installed GPU-aware
instructions were loaded. Both commands nevertheless used ordinary `bash`;
there was no `request_command_access` call with `gpu: "metal"` and no
`metal_command` result. The Saragossa pipeline ended with a successful `head`
without `pipefail`. The Swift diagnostic printed `nil device` / `all: []`, then
`exit=0`. Both tool results had `isError: false`, so neither was eligible for
one-command approval. This is not a failure of the approved Metal backend.

The installed broker/backend passed all ten native approval checks again:
compute, protected writes, one-shot consumption, journal, ordinary GPU denial,
nested-upgrade denial, session cancellation and descendant cleanup. Report:
`/Users/ludwig/.pi/metal-guidance-2026-10-04T21-57-45Z/native-recheck.json`.
The harness confirms only its small compute workload, not full Saragossa inference.

[PR #3](https://github.com/Destynova2/pi-agent/pull/3), merged as
`1aef9f79d34e98b9221c032f77cc775e9d602f7c`, clarifies the tool guidelines, system
instructions and `/confined-tools`. Its two runtime files were installed with
backup at `/Users/ludwig/.pi/metal-guidance-2026-10-04T21-57-45Z/`.
Twelve focused tests passed. A fresh Pi RPC process loaded the clarified Metal
notice and the existing LSP/MCP/host/Git commands without a model call; evidence
is in the same backup directory as `fresh-pi.json`. Existing interactive sessions
were not restarted. No driver, file, network or approval rule changed.

For an intended GPU command, preserve its real failure status (`set -o pipefail`
when using a pipeline), keep it foreground with `timeoutAction: "kill"`, and
make a missing-device probe exit nonzero. Then request `gpu: "metal"` against
the exact captured `failed_call_id`. The confirmed command runs once for at
most 60 seconds. Installation or restarting Pi never enables ordinary Bash GPU
access. Only errors from that approved rerun can support changing its backend
policy; unrelated WindowServer/IOAccel/gpumemd denials are not sufficient evidence.

## Native Metal diagnosis on Codex 0.160.0

Verified on 2026-10-04 with macOS 26.5.1 (25F80), Apple M5 Max with 40 GPU
cores. `system_profiler SPDisplaysDataType` reports Metal support. The installed
backend is `codex-cli 0.160.0`, arm64, SHA-256
`112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`.

The existing `tests/fixtures/metal-probe.swift` compiled successfully inside
Codex using `swiftc -module-cache-path ./module-cache probe.swift -o metal-probe`.
The probe then ran with the same `sandboxArgs()` filesystem/network policy and
the supported diagnostic switch `codex sandbox --log-denials`. It exited 77,
printing `METAL_UNAVAILABLE`. The relevant native denials were:

```text
(metal-probe) iokit-open-user-client IOSurfaceRootUserClient
(metal-probe) iokit-open-user-client AGXDeviceUserClient
```

The actual installed binary embeds an IOKit allow rule for
`RootDomainUserClient` only. Combined with the native denial, this identifies
the first blocking boundary: the process cannot open the GPU/surface driver
clients, and `MTLCreateSystemDefaultDevice()` returns nil. Successful Swift
compilation verifies host code compilation/linking, not GPU access. The probe
has not reached `makeLibrary`, command queue creation or kernel execution.

Other denied lookups include notification, logging, directory and WindowServer
services. The trace does not prove that every denied operation is needed for
compute, nor that allowing just the two observed IOKit classes would be
sufficient. Later Metal compiler/XPC requirements remain untested. No sandbox
rule was relaxed and no unconfined compute comparison was run.

The reproduction artifacts are in
`/private/tmp/pi-metal-diagnosis-LnjH4C/{compile,metal-denials}.json`; these are
temporary evidence, not an installation dependency. The negative integration
test remains the repeatable baseline. The public
[Codex 0.160.0 base policy](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)
agrees with the installed rule. Similar reports remain open upstream:
[Metal enumeration #16931](https://github.com/openai/codex/issues/16931) and
[IOKit restrictions #17644](https://github.com/openai/codex/issues/17644).
Their suggested workarounds are not accepted qualification of this setup.

A supported backend capability must open only the necessary GPU services for
one approved command while retaining the existing file/network restrictions.
The two denied class names are diagnostic evidence, not a complete or reviewed
permission profile. The positive compute, negative file/network tests, ordinary
command isolation, deadline, cancellation and result journal remain required
before delivery. Restarting Pi, changing the model, installing Python/MLX or
adding file/network grants cannot change the installed IOKit rule.

## Bash failures on Pi 1.0.1

`pi-background-bash` 0.0.3 discards the built-in tool's result. Pi 1.0.1 can
return a structured error rather than throw: a child exits 7, the wrapper
fulfills, and the command-access hook sees `isError: false`. No eligible
failed call is recorded. This is not a human refusal.

`patch-background-bash.mjs` makes the shared completion handler reject on a
nonzero or missing process exit code. Output text is not used to infer
failure. Cancellation, timeout and background completion remain intact.

The patch accepts only the exact known 0.0.3 artifact, retains a backup,
checks for concurrent target replacement, and atomically replaces one file.
Unknown versions/content are refused. An existing patch is accepted only
when reversing it reproduces the original SHA-256.

Operator activation, outside the agent's protected runtime write boundary:

```sh
node scripts/patch-background-bash.mjs \
  "$HOME/.pi/agent/npm/node_modules/@richardgill/pi-background-bash"
```

Restart Pi afterward. Fixture tests are not evidence that an existing
session loaded the patch. A package reinstall can remove it; revalidate
and reapply the pinned patch after reinstalling 0.0.3. A newer package
requires compatibility review, not forced patching.

Tests use the installed Pi SDK and an unmodified package copy, no shell or
provider calls. They also exercise command-access capture and human refusal:

```sh
PI_BACKGROUND_BASH_SOURCE=/canonical/path/to/unmodified/package \
  node --test --import ./tests/resolve-pi.mjs tests/background-bash-status.test.mjs
```

## Avoid opaque waits, not security boundaries

- Start known long operations in the background with an explicit job-level
  deadline when they are finite tasks. Bash handoff timeout is not a kill
  deadline. Keep long-lived servers explicitly separate.
- Preserve the process ID, raw log location, exit status and partial effects.
  A heartbeat proves the supervisor is responsive, not that the job advances.
- Continue independent work. Do not poll continuously or restart a failed
  operation automatically.
- For a denial, use the matching supported exact approval capability. If the
  capability is absent, state it once and prepare/test the change separately.
  Never use desktop typing, another executor or a broader grant as a fallback.
- Preparing an adaptation does not authorize installing it. Runtime changes
  remain reviewable and human-controlled; secrets and project permissions
  are not learned from terminal output or incident notes.

## Saragossa trace capture

The separate `tools/trace-metal.py` developer helper uses Python's standard
library and existing Rust trace flags; the inference engine is unchanged.
From the Saragossa checkout:

```sh
python3 tools/trace-metal.py --model-dir models/Qwen3.8-27B-oQ6
```

Defaults: Metal, `Bonjour`, 8 tokens, temperature 0, 120-second deadline,
10 MiB raw-output cap. A progress line appears every five seconds. Child
arguments are passed as argv, not a multiline shell pipeline. Full kernel
names remain distinct (`u6` versus `u8`). Resident matching lines are evidence
only of printed diagnostics, not proof of GPU residency.

Each run gets a private directory under `target/metal-traces`, with
`trace.log` and `summary.json`. They can contain private prompts and paths;
do not commit them. Summaries disclose truncation. Timeout exits 124,
output cap 125, startup/cleanup failure 126, interruption 130; ordinary child
failures retain their exit status. Signals map to 128 + signal number.
The supervisor terminates its own process group, including descendants;
cleanup failures are reported, not silently treated as success.

Use `--output-dir` for another authorized private location. No GPU or
filesystem denial triggers an automatic host fallback or retry. Tracing
adds overhead: this is not a performance benchmark.

Codex 0.155.1's [macOS base profile](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)
starts with `deny default` and allows only `RootDomainUserClient` for IOKit,
not the GPU user clients required by Metal. Its
[standalone launcher](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/cli/src/debug_sandbox.rs)
does not expose a GPU permission. A capture can therefore exit with
`aucun device Metal disponible` before running any kernel. This is not
fixed by additional filesystem roots, restarting Pi or disabling networking.
Do not replay the binary through a desktop terminal or an unrestricted host
operation. Enabling GPU access requires a separately reviewed backend
capability and native checks proving filesystem/network confinement is
retained. The stock launcher cannot grant it; the separately qualified
[experimental backend](../experiments/metal/README.md) uses the existing
`request_command_access` tool with `gpu: "metal"` for one approved command.

Offline checks use fake executables only:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_trace_metal.py -v
```
