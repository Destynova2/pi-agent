# Installation

This document describes how to fetch this repo somewhere other than a live pi agent directory, then install it. Source files and installed state are separate; validate an isolated test target before deploying.

## Source vs target

This repo (`pi-agent`, remote `https://github.com/Destynova2/pi-agent.git`) is a **configuration source**, not an installed state. `scripts/install.mjs` explicitly refuses any target that is identical to or nested with the source (paths compared in canonical form, symlinks resolved): source and target must be two distinct, non-nested directories, otherwise the installer stops before any write.

Clone into a separate directory, never directly into the target agent directory:

```bash
git clone https://github.com/Destynova2/pi-agent.git ~/src/pi-agent
cd ~/src/pi-agent
```

## Prerequisites

- Node.js `>=22.19` (`package.json` → `engines.node`). `node:sqlite` must be available (checked by `doctor`, native since Node 22.5+, enabled by default from 22.19).
- [`pi`](https://github.com/earendil-works/pi) `>=0.99.1` installed and on `PATH`. Check `pi --version`; `lastChangelogVersion` only records which changelog the UI has shown, not the installed, minimum or tested version. See [runtime compatibility](#runtime-compatibility).
- `git`, `curl`, Codex >=0.155.1 with a working OS sandbox and managed proxy.
- Optional, diagnosed but non-blocking: `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`. Podman must also have a working connection/VM for container operations; binary presence alone is insufficient.

This repo has **no npm dependencies** (`scripts/` and `tests/` are pure Node stdlib, see `package.json` description). There is no `package-lock.json`: `npm ci` would fail for lack of a lockfile and has nothing to install anyway.

## Runtime compatibility

Minimum Pi API version: **0.99.1**. Previous native-host validation used Pi 0.99.1; it does not establish compatibility of every adapter with later releases.

Pi **1.0.0** was previously staged separately for SDK and offline tests, without changing the live runtime or making provider calls. Targeted tests on Node **26.9.0** cover memory recall, installer migration, MCP boundaries, the paste patch and LSP lifecycle with a fixture server. The confined LSP loader now uses Pi's installed jiti instead of Node's removed TypeScript transform mode; no compiler dependency is added to this repo. That earlier 1.0.0 validation was incomplete: nested sandbox/cache restrictions and a network 403 affected its broad suite. Do not treat the package's open-ended Node engine range as a tested compatibility matrix.

To reproduce against an isolated runtime:

```bash
RUNTIME="$(mktemp -d)"
npm install --prefix "$RUNTIME" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.0
export PI_PACKAGE_JSON="$RUNTIME/node_modules/@earendil-works/pi-coding-agent/package.json"
npm test
npm run test:integration   # requires a host that can run the real Codex sandbox
```

The paste keepalive patch now pins the published **1.0.0** artifacts as well as 0.87.1 and 0.99.1. The real bundled `ProcessTerminal` test reproduces a simulated mode-2004 reset: upstream does not re-enable paste periodically, the patch does. It checks TTY gating, timer cleanup and idempotence; it does not validate the physical terminal or clipboard. Apply only to a staged runtime if that reset affects your terminal:

```bash
node scripts/patch-paste.mjs "$RUNTIME/node_modules/@earendil-works/pi-coding-agent"
```

Run the pristine-runtime tests before patching it. Unknown artifact hashes or versions remain refused. No global install, shell wrapper or running session is changed by these commands. Pi 1.0.0 defaults to fullscreen; use `"tuiMode": "regular"` if desired, and `"quietStartup": "header"` to hide resource listings. These display preferences are not imposed by the installer.

Pi **1.0.4** is the current upgrade target. Apply the pinned trust-order and paste corrections to its staged runtime, then run the native integration gate with the installed SDK manifest and the separate pristine 1.0.0 paste fixture. The installed-runtime paste regression also checks the selected SDK's exact published CLI artifact before and after patching. Linux Git approval uses the [metadata transaction path](docs/ORCHESTRATION.md#linux-git-transactions); it preserves read-only configuration and hooks and keeps ordinary Bash confined.

## Quickstart

```bash
node scripts/doctor.mjs            # diagnostic before installing anything
node scripts/install.mjs --target ~/.pi/agent-test   # install to a test target, never the source
node scripts/doctor.mjs --target ~/.pi/agent-test
```

To install to pi's default target (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`):

```bash
node scripts/install.mjs
```

## Validate before activating

Run this from a host terminal capable of starting Codex's sandbox, not from inside the agent's restricted shell. If `pi` is a wrapper, first set `PI_PACKAGE_JSON` to its installed SDK manifest as described above. The live target is not touched until the full staged gate passes:

The deployment script runs these gates, keeps logs under `$TMPDIR`, then asks for `DEPLOY` before updating the live target:

```bash
export TMPDIR="${TMPDIR:-$(node -p 'require("node:os").tmpdir()')}"
export PI_PACKAGE_JSON="/absolute/path/to/node_modules/@earendil-works/pi-coding-agent/package.json"
bash scripts/deploy.sh
```

Replace the example SDK path with the installation used by `pi`. For a shell wrapper, inspect the launcher returned by `command -v pi`: its CLI path identifies the package directory containing `package.json`. Keep the entire exported path on one line. A pasted newline inside `node_modules` becomes part of the filename and causes `ENOENT`; the script rejects it before staging. It also rejects missing files, invalid JSON and manifests for another package without changing the selected path.

To run the stages individually:

```bash
STAGE="$(mktemp -d)" &&
npm install --prefix "$STAGE/paste-fixture" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.0 &&
export PI_PASTE_PACKAGE_JSON="$STAGE/paste-fixture/node_modules/@earendil-works/pi-coding-agent/package.json" &&
node scripts/install.mjs --target "$STAGE/agent" &&
node scripts/doctor.mjs --target "$STAGE/agent" --installed &&
PI_CODING_AGENT_DIR="$STAGE/agent" npm run verify:integration &&
node scripts/install.mjs &&
node scripts/doctor.mjs --installed
```

`PI_PACKAGE_JSON` must still point to the SDK of the runtime you will use. `PI_PASTE_PACKAGE_JSON` selects only the pristine 1.0.0 artifact for the paste regression test; it does not upgrade Pi or replace the SDK under test. An explicitly supplied invalid fixture fails, including outside integration mode.

Keep the stage and failure output if a gate fails; do not continue to the live install. Successful installation prints the backup location. Restart Pi with `--no-approve`; an already-running session keeps its old executors. MCP server definitions and provider logins are user-owned and are not invented or copied into the stage. This gate checks fixture-backed services and OS boundaries, not authenticated search or a live PR subscription.

The installer pins `typescript@7.0.2` through Pi's package manager and configures its native LSP entry point by absolute path. No global `tsc`, project dependency or network download on first LSP use is needed. Routing includes TS/TSX and JS/JSX/MJS/CJS with package/Git root markers. The exact old shipped TypeScript definition is migrated; custom servers, other LSP settings and disabled-server preferences remain unchanged. `--no-packages` does not install this server: `doctor --installed` reports it missing.

## `scripts/install.mjs`

Idempotent, Node stdlib only. Before any mutation:

- refuses if the target is a symlink, if source == target, or if one contains the other (comparison on canonical paths, legitimate system aliases such as `/tmp` ↔ `/private/tmp` on macOS resolved, not rejected);
- refuses if a symlink exists anywhere under a managed resource (source or target) — would allow a write outside the target during the copy;
- validates the minimal JSON schema of `settings.json` (source and target) before any write.

Managed directories/files (`MANAGED_DIRS`/`MANAGED_FILES` in `scripts/install.mjs`): `agents/`, `extensions/`, `lib/`, `gates/`, `scripts/codex-shell.mjs`, `scripts/codex-tool.mjs`, `scripts/codex-network.mjs`, `scripts/metal-backend.mjs`, `scripts/build-worker.mjs`, `scripts/web-read-worker.mjs`, `scripts/git-operation.mjs`, `scripts/git-hook-guard.mjs`, `scripts/jj-checkpoint.mjs`, `scripts/git-hooks/`, `scripts/confined-tool.mjs`, `scripts/confined-lsp-worker.mjs`, `keybindings.json`, `settings.json`. The shell launcher retains its executable mode and is backed up on reinstall; other personal scripts are not managed. **Never touched**: `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `network-policy.json`, `mcp.json`, `mcp-approvals/`, nor any file outside this list except the explicitly retired legacy policy files (including `skills/`, see below).

Installation now enables the [strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox): it replaces `shellPath` with the installed Codex adapter, preserving the previous settings in the backup. With the [pinned trust-order patch](#plain-pi-startup-on-supported-runtimes) installed, restart Pi normally. `--no-approve` is only a workaround for an unpatched runtime. File tools and Bash run confined without routine approval prompts. Predefined network hosts are automatic. An exact public HTTP(S) URL supplied by the user can be read by `web_fetch` without another confirmation; its fixed GET worker receives only that destination, without cookies, redirects, uploads or a grant to Bash. `request_network_access` still confirms broader session access to additional public hosts, without widening filesystem access. Notes, Graphify, Git inspection, web helpers, CI queries, LSP and configured local MCP servers use confined executors; delegation inherits only confined capabilities. Dunst remains denied by the local strict dispatcher. Its separate implementation retains consent checks. The parent-only [host operation bridge](docs/ORCHESTRATION.md#one-host-operation) separately confirms bounded Podman, clipboard and process operations. It never opens Bash or delegates host access. Recognized failures are recorded through the existing confined Notes worker. See [MCP and desktop consent](docs/ORCHESTRATION.md#mcp-and-desktop-consent) for approval choices, scope and revocation. Unknown tools remain denied. Stable Codex >=0.155.1 must be installed and its OS sandbox and managed proxy must work. The installer backs up then deletes `tool-policy.json` and its obsolete parser/classifier files. It also retires `extensions/model-fallback/index.ts`: the old `fallback/anthropic-astra` default becomes the source's direct model, while other model preferences and native retry settings stay unchanged. There are no API pings, quota-error rewrites or custom provider switches. Resumed sessions may still name the removed virtual model: select a real model with `/model`. Installing this source does not alter saved sessions. The LSP package remains pinned to 0.4.4 with `extensions: []`, preventing its unconfined hooks from loading alongside the replacement. The confined adapter loads that package inside its worker. Do not remove the package or enable its original extension. Configure local MCP servers in the user-owned `mcp.json` described in [Strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox).

Sequence: back up the existing target into `<target>.backup-<timestamp>/` (created with `0700` permissions), then copy file by file (never deletes a target directory: any personal addition in a managed directory survives a reinstall), then merge `settings.json` (string and filtered-object package entries are supported; packages managed by the source replace their counterpart by identity — without the `@version`/`@sha` suffix — in the target; personal target packages with no source counterpart are kept), then `pi install <source> --no-approve` for each listed package.

Options:

```bash
node scripts/install.mjs --target <path>   # default: $PI_CODING_AGENT_DIR or ~/.pi/agent
node scripts/install.mjs --no-packages        # copies files, does not invoke `pi install` (offline mode)
```

A failure of an individual package (`pi install`) is reported but does not block the copy of other resources; the output then makes clear not to treat the installation as a full success.

### Linux KVM image builds

The installed `request_build_access` tool supports the fixed project entry point `ansible-playbook -i localhost, ansible/build.yml`. It uses a separate Bubblewrap sandbox, exposes only `/dev/kvm` in addition to standard devices, and grants the full native host network after one explicit approval. Writes are limited to `.cache/`, `output/` and private temporary storage; build sources remain read-only. It supports a supervised foreground run of 120 minutes by default, up to 240 minutes. Ordinary Bash permissions remain unchanged.

The host needs accessible KVM, `/usr/bin/bwrap` with `--disable-userns`, `/usr/bin/python3`, and installed build dependencies. The tool checks KVM inside the actual build sandbox before starting Ansible. Install through the normal staging workflow and restart Pi; no Codex rebuild or generic `/dev` grant is needed. `/build-access reset` cancels the operation and clears refusals. See [the capability, network scope and native validation](docs/ORCHESTRATION.md#kvm-image-builds). Source/unit validation alone does not establish hardware availability or a successful RHEL image build.

### Plain `pi` startup on supported runtimes

Unpatched Pi 0.99.1 and 1.0.1–1.0.4 skip personal `project_trust` handlers when a directory has no protected project resources. It marks that directory trusted, which the confined-tool broker correctly refuses. `defaultProjectTrust: "never"` does not fix that early return.

After backing up the Pi package, apply the pinned runtime correction:

```bash
node scripts/patch-project-trust.mjs <Pi-package-root>
```

This changes the CLI startup condition and moves the empty-project shortcut after personal trust handlers in both the bundled CLI and unbundled runtime. Our existing handler then declines host-side project resources automatically, including previously trusted projects. Tool guards, native explicit CLI overrides, and the no-handler fallback remain unchanged. No alias, recurring flag, or trust-store edit is needed.

The patch accepts only exact known Pi 0.99.1 and 1.0.1–1.0.4 artifacts, validates every target before writing, and is idempotent. The 1.0.1–1.0.4 pins were matched against registry tarballs with SHA-512 integrity checks, not inferred from old filenames. Unknown versions or modified artifacts are refused. It does not touch the paste patch. The paste mitigation also supports the verified 1.0.4 artifacts.

For the separate bracketed-paste keepalive mitigation, back up both the coding-agent package and its resolved `pi-tui` dependency, then apply `node scripts/patch-paste.mjs <Pi-package-root>`. Supported versions are pinned in `patches/paste-keepalive.mjs`, including 1.0.1. Already-patched content is reverse-validated against its pristine hash. This mitigation re-enables paste mode on TTYs; it does not establish the original cause of every paste failure. Upgrades replace both runtime patches. Never force old hashes or remove sandbox guards. The configuration installer does not modify the Pi runtime; after a Pi upgrade, revalidate runtime compatibility instead of forcing this patch onto a new version.

Already-running processes need one normal restart, not `/reload`: reload retains their old trust state and cannot undo host code that already ran. Quit Pi, then use `pi --resume` in the same project and select the existing conversation. Future launches use plain `pi`.

### Updating a private patched runtime

A shell launcher pointing into `~/.local/share/pi-runtime/` is not a global npm installation. Upstream `pi update` cannot replace it. Enable this repo's updater from a host terminal capable of running the native integration gate:

```bash
node scripts/update-runtime.mjs --install-launcher \
  --package-json /absolute/path/to/node_modules/@earendil-works/pi-coding-agent/package.json
```

The default launcher is `~/.local/bin/pi`; use `--launcher <path>` for another regular file. The command checks that both runtime patches are already present, runs `npm run verify:integration` against that runtime, and only then backs up and replaces the launcher. It does not patch the active runtime. Keep this source checkout at the same location: the launcher invokes its updater directly, so future reviewed patch definitions are available without reinstalling the launcher. The configuration installer does not enable this runtime launcher.

After activation, `pi update` and `pi update --self` query npm's latest stable version. A supported version is installed in a new sibling runtime directory with lifecycle scripts disabled and the matching `pi-tui` version pinned. Both patches must pass their artifact checks, followed by the full native integration gate, before the launcher switches atomically. An up-to-date runtime has both patches checked without reinstalling; `--force` stages a fresh copy and reruns the gate. The old runtime and a `pi.backup-<id>` launcher remain available for rollback. Restore that launcher backup to select the old runtime; restart running sessions to use a new runtime.

`pi update --all` and `pi update --self --extensions` update the runtime first, then invoke Pi's extension updater. An extension failure retains its native exit status but does not roll back a successfully activated runtime. Extension-only updates, positional extension sources, model updates, help and invalid arguments are passed to Pi unchanged.

Unknown versions are refused before downloading or activating a candidate. The validated patch versions remain those in `scripts/patch-project-trust.mjs` and `patches/paste-keepalive.mjs`; adding the updater does not establish compatibility with newer releases. Validate the published artifacts and add their pins before upgrading. The updater never guesses hashes or removes trust protections.

Logs and the separate pristine Pi 1.0.0 paste fixture live under `$TMPDIR` (or the OS temporary directory). Set `PI_PASTE_PACKAGE_JSON` to an existing pristine fixture to reuse it. Failed candidates are retained for diagnosis; the launcher remains unchanged on install, patch or gate failure. Concurrent updates are refused by a sibling `<launcher>.update-lock` directory. After an interrupted process, remove that directory only once no updater is running. Network access to npm, write access to the private runtime/launcher, and a working host sandbox are required; an agent's restricted shell is not sufficient to activate an update.

### Recovering after a problem

The previous backup remains at `<target>.backup-<timestamp>/` — restore it manually (`cp -a <backup>/<entry> <target>/<entry>`), entry by entry if needed. This is **not** a `git checkout` nor a `jj restore`: the install target is not necessarily a Git/jj repo, and the installer never assumes it is one.

### jj checkpoints before edits

The installed `jj_checkpoint` capability initializes jj/Git only when missing, then
records local working-file recovery points before new modification tasks. Initial
setup asks once; later snapshots can have separate session/project consent. It
preserves the existing Git index, branches and files and returns full operation and
commit IDs. Restoration remains a separate explicit action. Ignored untracked files
and external state are not backed up. See [scope, limits and the required native
gate](docs/ORCHESTRATION.md#local-jj-recovery-points) before activation. Installing
these files does not itself initialize a repository or create a checkpoint.

## Linux exact-file grants

On Linux, exact file write grants require the bundled [Codex file-root repair](patches/codex-linux-file-roots.md).
The tested upstream 0.155.1 and 0.160.0 binaries try to mask metadata directories beneath a regular file and fail before running the command.
Pi prefers `~/.local/share/pi-codex/0.155.1-file-roots/codex` when present; `PI_CODEX_SANDBOX_BIN` always takes precedence.
This private backend leaves the regular `codex` command unchanged. The test runner uses the same selection.
The repair's build script checks the upstream archive checksum and uses the locked dependencies; see the linked instructions to rebuild and verify it.

Notes create their fixed storage targets before confinement because Linux bind mounts require existing paths.
The central `~/workspace/notes.db` uses a persistent rollback journal on Linux so SQLite does not need to unlink mounted files.
Existing WAL databases are preserved; close active Pi sessions before deployment so their connections can release database locks.
Only the notes files are writable to the notes worker; the surrounding workspace remains protected.

## `scripts/doctor.mjs`

```bash
node scripts/doctor.mjs [--target <path>] [--strict] [--installed]
```

Checks the Node version (against `engines.node` in `package.json`), `node:sqlite` availability, required commands (`git`, `curl`, `pi`, `codex`) and optional ones (`graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`), as well as the executable presence of `gates/pi-prek` in the target. `--strict` also fails on a missing optional tool (warning only by default). Never reads or displays `auth.json`.

`--installed` additionally compares the selected executable boundaries with this source, checks the confined shell path, verifies upstream LSP hooks are filtered and checks pinned LSP/TypeScript package versions. A stale installed policy or missing worker fails this check. MCP configuration presence is reported separately; it does not prove a server works. This is a deployment-readiness check, not a substitute for the full integration gate.

## Tests

```bash
npm run check            # .mjs syntax (node --check) + whitespace hygiene + git diff --check
npm test                 # standard node:test suite, excludes *.integration.test.*
npm run verify           # syntax + standard suite
npm run verify:integration # syntax + full suite + python3 -m unittest test_gates
```

`npm test` loads `tests/resolve-pi.mjs` via `node --import` for the repo's real suite: this file only redirects the specifiers `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` to the `pi` installation actually found on `PATH` (or `PI_PACKAGE_JSON`), via `node:module.registerHooks` (synchronous hook, same thread — no `data:` URL, no `eval`, no temporary symlink). The found `package.json`'s name is verified (`@earendil-works/pi-coding-agent`) before any use.

Tests that launch the real Codex sandbox (including registered Git inspection and Graphify root selection) and real loopback HTTP live in `*.integration.test.*`. They are not silently skipped inside a restricted shell: the full gate still runs them and fails if the required capability is absent. Standard tests cover the service logic, isolated worker protocols, permission checks and installed resource registration.

In `--integration` mode, each missing external dependency (git, jj, graphify, installed `pi`…) explicitly fails a test rather than silently skipping it (`PI_TEST_INTEGRATION=1`); the number of tests and their status therefore depend on the execution environment — do not hardcode a figure here, read the command's actual output.

`npm run test:integration` also runs `python3 -m unittest test_gates -v` in `gates/pi-orchestrate/` if `python3` and `test_gates.py` are present; otherwise, the absence is explicitly reported (not a silent success).

## Gates (`gates/pi-prek`, `gates/pi-orchestrate/gates.py`)

`extensions/orchestrate/index.ts` invokes the `gates/pi-prek` binary copied into the agent directory (resolved via `getAgentDir()`), unless `PI_GATES_BIN` selects an alternative binary. In both cases it goes through the installed Codex launcher; there is no direct host execution fallback. A gate requiring forbidden filesystem or network access fails. Calling `gates/pi-prek` manually from a host terminal is separate and does not create a sandbox itself.

`gates/pi-prek` is a POSIX wrapper (`#!/bin/sh`) that resolves its own real location (symlinks included) then runs `python3 gates/pi-orchestrate/gates.py` next to it — no hardcoded `$HOME` or username.

`gates.py` requires:

- a colocated **jj + Git** repo (`.git` as a directory, not a gitlink file);
- a per-project policy at `~/.config/pi-orchestrate/projects/<sha256(real_root_path)[:20]>.json`, with `root` (real absolute path of the root, must match exactly, `realpath` included) and `required` (non-empty list of mandatory commands in `full` mode) — see `gates/pi-orchestrate/example-policy.json`, which documents the format but is **never read or created automatically**; copy it manually and adapt it;
- `prek` and `gitleaks` installed (diagnosed as optional by `doctor`, but required for the gates to work);
- no bypass environment variable (`SKIP`, `PREK_SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`, `GITLEAKS_CONFIG`, `GITLEAKS_CONFIG_TOML`) set.

Inside Codex, gate candidates, locks and receipts live under `$TMPDIR/pi-orchestrate/gates/`; the Prek cache uses `$TMPDIR/prek`. Standalone host execution retains `~/.cache/pi-orchestrate/gates/`. A receipt records checks, never permission to publish or bypass sandbox restrictions. Tools invoked by a gate may need additional project-specific cache configuration; forbidden writes remain failures.

Three modes: `quick` (`pre-commit` hooks only), `full` (all stages + policy commands, run in a separate cloned copy, produces an `approved.json` receipt in the cache if everything passes), `dry-run`. **`dry-run` is not a no-op**: it actually runs `prek run --all-files --stage <stage> --dry-run` on the repo root itself (not an isolated copy), unlike `full` mode which works on a disposable clone — do not treat it as a fully inert simulation.

## `skills/cli-code-skills`: unbundled external dependency, manual restore

`settings.json` (`packages` key) **cannot** declare `cli-code-skills`: this external repo has neither a `skills/` directory at its root nor a `package.json` manifest recognized by `pi`'s package discovery (`hasAnyDir=false`, verified empirically — 0 skills loaded via `pi install`). The only integration that works is a directory (or symlink) under the agent's conventional skills directory (`skills/`). `scripts/install.mjs` never manages `skills/` (absent from `MANAGED_DIRS`): an existing symlink there survives any install/reinstall intact, without double activation.

This repo ships **no snapshot** of `cli-code-skills` and the installer does not install it automatically. If you want these skills, restore them manually from the known repo, pinned to a specific commit, guarding that the destination does not already exist:

```bash
DEST="<target agent directory>/skills/cli-code-skills"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "refused: $DEST already exists (file, directory, or symlink) — will not overwrite" >&2
else
  git clone https://github.com/Destynova2/cli-code-skills.git "$DEST"
  git -C "$DEST" checkout --detach 7541b6938e18ffc78065800060444bb623aecd3c
fi
```

Replace `<target agent directory>` with your own install path; do not copy a `/Users/...` path from a third-party machine. This step is an external dependency declared in this documentation, not a guarantee shipped with the repo: the installation described above does not run it for you.

## What this documentation does not guarantee

- **Cross-platform GPU access**: the optional [Metal backend](experiments/metal/README.md#platform-support) requires macOS on Apple Silicon and separate native qualification. A Linux GPU backend remains to be developed and validated; installing the shell sandbox does not grant GPU access.
- **Every Linux environment**: the installer and full integration suite were validated on native Fedora 44 with Pi 0.99.1, Node 26.9.0 and Codex 0.155.1; Darwin-only tests remain skipped there. This does not validate restricted containers or other kernels. Check the real Codex sandbox before enabling it; unavailable namespace support must remain a failure.
- **Full automation**: this installation copies files and invokes `pi install`, it does not configure model authentication (handled by `pi` itself, never by an export from this repo) nor declared-but-unbundled external dependencies (`skills/cli-code-skills` above).
- **Recovery**: in case of a problem, restore from the `<target>.backup-<timestamp>/` backup created by the installer, never via a `git checkout`/`jj restore` of the target (which may not be a versioned repo).
