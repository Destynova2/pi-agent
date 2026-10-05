#!/usr/bin/env bash
# Build the pinned Linux backend repair; choose the output path explicitly.
set -euo pipefail
umask 077

if [[ $# != 1 || "$1" != /* || $(uname -s) != Linux ]]; then
  printf 'Usage (Linux): bash scripts/build-codex-sandbox.sh /absolute/output/codex\n' >&2
  exit 2
fi
for command in cargo rustc curl tar patch sha256sum strip; do
  command -v "$command" >/dev/null || { printf 'Missing command: %s (Rust >=1.95 required)\n' "$command" >&2; exit 1; }
done
output=$1
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export TMPDIR="${TMPDIR:-$(node -p 'require("node:os").tmpdir()')}"
build=$(mktemp -d "$TMPDIR/pi-codex-build.XXXXXXXX")
printf 'Build directory and logs: %s\n' "$build"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v0.155.1 \
  --output "$build/source.tar.gz"
printf '%s  %s\n' b9e18d40d322586913e94d6747f3f934922c4f5130eb5a349ba019c57b83dad8 "$build/source.tar.gz" | sha256sum --check
tar -xzf "$build/source.tar.gz" -C "$build"
source_dir="$build/codex-rust-v0.155.1"
patch --batch --fuzz=0 -p1 -d "$source_dir" < "$repo/patches/codex-linux-file-roots.patch"
export CARGO_TARGET_DIR="$build/target"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}" CARGO_PROFILE_DEV_DEBUG=0
if cargo build --locked --manifest-path "$source_dir/codex-rs/Cargo.toml" -p codex-cli --bin codex > "$build/build.log" 2>&1; then
  mkdir -p -- "$(dirname -- "$output")"
  install -m 755 "$build/target/debug/codex" "$output"
  strip "$output"
  "$output" --version
  printf 'Built %s; run verify:integration with PI_CODEX_SANDBOX_BIN set to this file before deployment.\n' "$output"
else
  status=$?
  tail -60 "$build/build.log" >&2
  exit "$status"
fi
