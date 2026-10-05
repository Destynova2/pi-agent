# Linux exact-file write grants

Upstream Codex 0.155.1 and 0.160.0 add protected metadata children to every writable root, including regular files. Bubblewrap then fails to mount paths such as `file/.git` or `file/.codex` with `ENOTDIR`. This breaks one-shot file grants and the confined notes worker.

`codex-linux-file-roots.patch` targets the official `rust-v0.155.1` source. It omits child metadata masks for regular files only. Directory masks, denied paths, read-only mounts, process isolation and network restrictions are unchanged. The patch includes a regression assertion in the existing writable-file test.

Build on Linux with Rust 1.95 or newer, a C toolchain, Cargo, Node, curl, tar, patch, sha256sum and strip:

```bash
export TMPDIR="${TMPDIR:-$(node -p 'require("node:os").tmpdir()')}"
build_output="$(mktemp -d "$TMPDIR/pi-codex.XXXXXXXX")/codex"
bash scripts/build-codex-sandbox.sh "$build_output"
PI_CODEX_SANDBOX_BIN="$build_output" npm run verify:integration
# Install only after that gate passes; keep an existing backend as a backup.
install -D -m 755 "$build_output" "$HOME/.local/share/pi-codex/0.155.1-file-roots/codex"
```

Set `PI_PACKAGE_JSON` to the active Pi SDK and `PI_CODING_AGENT_DIR` to the staged installation as described in [INSTALLATION.md](../INSTALLATION.md). The paste regression also requires its pristine fixture. The build keeps logs under `$TMPDIR`, verifies the official archive's SHA-256 and uses Cargo's locked dependencies. It produces an unoptimized, stripped binary; no model calls are involved in its use as Pi's sandbox backend.

Pi selects this private binary automatically on Linux. It does not replace the package-manager installation or the ordinary `codex` command. An explicit `PI_CODEX_SANDBOX_BIN` overrides the selection. Keep the patch and the backend together until a newer upstream binary passes the same file-grant, notes, LSP and sandbox integration tests.
