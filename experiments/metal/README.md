# Experimental one-command Metal access

This is a local Codex backend patch and a Pi approval adapter, disabled unless an
operator installs a reviewed backend with a successful native qualification report.
It is not an upstream Codex feature, a production installation, or a general GPU
entitlement. No `host_command` or unrestricted executor is introduced.

## Upstream position, checked 2026-10-04

- [Pi](https://github.com/earendil-works/pi#permissions--containerization) deliberately
  leaves permission enforcement to extensions and external containers/sandboxes.
  Its sandbox example has no per-command Metal capability. Searches of Pi issues,
  pull requests and its public RFC index found no corresponding implementation or
  announced delivery date. This does not establish that none is planned privately.
- Codex tracks macOS sandbox/GPU limitations in
  [#16931](https://github.com/openai/codex/issues/16931) and
  [#17644](https://github.com/openai/codex/issues/17644). Neither provides a delivered
  scoped GPU grant. Do not treat reports about `danger-full-access` as evidence
  about this sandbox: a maintainer clarified that that mode should not use Seatbelt.
- [Codex contribution policy](https://github.com/openai/codex/blob/main/docs/contributing.md)
  currently excludes external code PRs. This experiment therefore lives in pi-agent.

## Boundary and approval

Stock Codex 0.160.0 permits Swift compilation but denies opening
`IOSurfaceRootUserClient` and `AGXDeviceUserClient`. Metal returns no device.
The patch adds `codex sandbox --allow-metal` only to the standalone macOS launcher.
It grants those two exact IOKit classes and the exact shader compiler XPC service
`com.apple.MTLCompilerService`, exempting only that service from the existing XPC
deny. File and network policies are unchanged. Unexpected policy text fails closed;
imported `--sandbox-state-json` cannot be widened with this option.

Pi reuses `request_command_access` after an actual failed foreground Bash call:

```json
{"failed_call_id":"the-failed-tool-call-id","gpu":"metal","reason":"Run the Metal computation"}
```

The human sees the stored command, cwd, optional additional write paths, backend
digest and 60-second deadline. Approval is consumed once. The backend digest is
checked before and after confirmation and again by the launcher. Cancellation,
timeout and session navigation stop the command tree. `metal_command` session
entries record start and completion/failure/cancellation, exact command, digest,
deadline and bounded output. Ordinary commands use the existing stock backend;
GPU grants do not enter child capability ceilings or persist across commands.

The driver and shader compiler are additional attack surfaces. This is not a
security certification or an independent audit. A qualification report is a
trusted operator record, not a signed attestation. Trusted host extensions and an
operator able to replace the runtime remain outside the workspace threat model.

## Reproduce without installing

Prerequisites: native Apple Silicon macOS, Xcode command-line tools, Node >=22.19,
the Pi SDK installation used by this repository, Rust 1.95.0 and Codex build tools
(`just`, `dotslash`, `cargo-nextest` for tests). These steps create a separate checkout.

```sh
node experiments/metal/prepare.mjs /private/tmp/codex-metal-review
cd /private/tmp/codex-metal-review/codex-rs
rustup run 1.95.0 cargo build --locked -p codex-cli --bin codex --profile dev-small
rustup run 1.95.0 just test -p codex-cli -p codex-chatgpt --cargo-profile dev-small
rustup run 1.95.0 just fmt
```

Preparation pins `rust-v0.160.0` to
`a956835d020762cb2b570053af06f643a11c0ecc`, checks the original lockfile digest and
applies the reviewable adjacent patch. The release has 159 workspace package
versions still at `0.0.0` in Cargo.lock; preparation changes only those to `0.160.0`.
External dependency versions, sources and checksums do not change. The patch also
raises `codex-chatgpt`'s recursion limit to 256 so the pinned compiler can build the
release. Existing destinations are refused; no checkout is reset.

From this repository, in a native terminal able to launch Seatbelt:

```sh
node experiments/metal/qualify.mjs \
  /private/tmp/codex-metal-review/codex-rs/target/dev-small/codex \
  /private/tmp/metal-qualification.json
node --import ./tests/resolve-pi.mjs experiments/metal/validate-pi.mjs \
  /private/tmp/codex-metal-review/codex-rs/target/dev-small/codex \
  /private/tmp/metal-qualification.json /private/tmp/metal-pi-validation.json
```

Every Metal computation runs inside the candidate's sandbox. The first harness
checks computation, file denials, direct TCP denial against a reachable control,
managed-proxy allow/deny, cancellation, timeout and ordinary GPU denial before and
after. The second exercises the real Pi broker and launcher with a test confirmation
UI, verifies the journal and session cancellation, and attempts a nested upgrade
from an ordinary sandbox. It does not claim a manual TUI approval was performed.
Both fail with a nonzero exit status; reports must use new output paths.

## Activation after review

The regular installer manages the adapter source only. It never builds, installs
or enables the experimental backend. For a reviewed installation, first back up
the agent directory and existing backend configuration, then stage these files
outside every writable project:

```text
~/.pi/agent/metal-backend.json
~/.pi/agent/backends/metal/codex
~/.pi/agent/backends/metal/qualification.json
```

Copy the exact qualified binary and its report; use regular files owned by the
operator with no hardlinks, symlinks, or group/other writes. The binary must be
executable. The manifest is `{"schema":1,"sha256":"<qualified binary digest>"}`.
The report must have passed every required check on the current OS release and
architecture. Rebuilds and OS updates require new native qualification. Do not
use a unit-test fixture or this repository's validation summary as that report.

After installing the reviewed adapter with the normal backup-producing installer,
restart Pi, check `/confined-tools`, then exercise a failed Metal command and its
single approved retry. Disabling/removing the manifest disables new Metal grants;
restore the runtime backup to roll back adapter changes. This review branch has
not been activated in the user's Pi installation.

See [validation](validation.md) for observed results and outstanding review limits.
The Codex patch is distributed under the adjacent [Apache 2.0 license](CODEX-LICENSE)
and [upstream notices](CODEX-NOTICE); the patch identifies all modified source files.
