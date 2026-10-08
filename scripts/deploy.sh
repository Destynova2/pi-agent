#!/usr/bin/env bash
# Run from a host terminal, with Pi sessions closed. Never bypasses a failed gate.
# PI_PACKAGE_JSON must name the SDK used by your pi executable (including wrappers).
set -euo pipefail
umask 077

if [[ $# != 0 ]]; then
  printf 'Usage: PI_PACKAGE_JSON=/path/to/pi/package.json bash scripts/deploy.sh\n' >&2
  exit 2
fi
: "${TMPDIR:?Set TMPDIR to a writable temporary directory outside this repository}"
: "${PI_PACKAGE_JSON:?Set PI_PACKAGE_JSON to your installed Pi SDK package.json}"
[[ "$PI_PACKAGE_JSON" = /* ]] || PI_PACKAGE_JSON="$PWD/$PI_PACKAGE_JSON"
export PI_PACKAGE_JSON
target="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
[[ "$target" = /* ]] || target="$PWD/$target"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for command in node npm pi codex git curl python3; do
  command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 1; }
done
# JavaScript template expressions below must reach Node literally.
# shellcheck disable=SC2016
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const path = process.env.PI_PACKAGE_JSON;
  try {
    if (/[\r\n]/.test(path)) {
      throw new Error("PI_PACKAGE_JSON contains a line break. Export the complete SDK package.json path on one line.");
    }
    let source;
    try { source = readFileSync(path, "utf8"); }
    catch (error) { throw new Error(`Cannot read PI_PACKAGE_JSON=${JSON.stringify(path)} (${error.code}). Check the installed Pi SDK path.`); }
    let manifest;
    try { manifest = JSON.parse(source); }
    catch { throw new Error("PI_PACKAGE_JSON must point to a valid JSON manifest."); }
    if (manifest?.name !== "@earendil-works/pi-coding-agent") {
      throw new Error("PI_PACKAGE_JSON must point to the installed @earendil-works/pi-coding-agent/package.json.");
    }
  } catch (error) {
    console.error(`deploy: ${error.message} See INSTALLATION.md.`);
    process.exitCode = 1;
  }
'
stage=$(mktemp -d "$TMPDIR/pi-deploy.XXXXXXXX")
printf 'Staging and logs (kept on success or failure): %s\nLive target: %s\n' "$stage" "$target"
on_exit() {
  local status=$?
  if (( status != 0 )); then
    printf 'Stopped (exit %s). Inspect %s; no automatic retry or rollback.\n' "$status" "$stage" >&2
  fi
}
trap on_exit EXIT
run() {
  local log=$1
  shift
  "$@" 2>&1 | tee "$stage/$log.log"
}

run check npm run check -- --evidence "$stage/check.json"
run stage-install node scripts/install.mjs --target "$stage/agent"
run stage-doctor node scripts/doctor.mjs --target "$stage/agent" --installed
run integration env PI_CODING_AGENT_DIR="$stage/agent" npm run verify:integration -- --reuse-check "$stage/check.json"

printf '\nStaged checks passed. Close other Pi sessions before proceeding.\n'
printf 'Deploy to %s with the existing installer backup? Type DEPLOY: ' "$target"
IFS= read -r answer
[[ "$answer" == DEPLOY ]] || { printf 'Cancelled; live installation unchanged.\n'; exit 0; }
run live-install node scripts/install.mjs --target "$target"
run live-doctor node scripts/doctor.mjs --target "$target" --installed
printf '\nDeployment checked. Backup path: see %s/live-install.log\nRestart Pi with: pi --no-approve\n' "$stage"
printf 'Provider authentication, personal MCP servers and physical clipboard are not validated by this gate.\n'
