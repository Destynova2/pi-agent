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
- [`pi`](https://github.com/earendil-works/pi) `>=1.0.4` installed and on `PATH`. Check `pi --version`; `lastChangelogVersion` only records which changelog the UI has shown, not the installed, minimum or tested version. See [runtime compatibility](#runtime-compatibility).
- `git`, `curl`, Codex >=0.155.1 with a working OS sandbox and managed proxy.
- Optional, diagnosed but non-blocking: `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`. Podman must also have a working connection/VM for container operations; binary presence alone is insufficient.

This repo has **no npm dependencies** (`scripts/` and `tests/` are pure Node stdlib, see `package.json` description). There is no `package-lock.json`: `npm ci` would fail for lack of a lockfile and has nothing to install anyway.

## Runtime compatibility

The package targets Pi **1.x, minimum 1.0.4**. The updater requires the native integration gate for each candidate; a compatible major version alone is not proof of compatibility.

No installed Pi or background-Bash package files are patched. Integration uses public extension, tool, widget and session APIs:

- Startup uses native `--no-approve`, supplied automatically by the managed launcher. This declines project resources; it does not disable tool approvals or the OS sandbox.
- The `terminal-paste` extension refreshes bracketed-paste mode through the public TUI terminal while Pi owns a raw TTY. Its widget lifecycle and session shutdown release the timer. This does not validate the physical clipboard.
- Foreground `bash` is Pi's native tool. Long-running commands use `bash_background`; `bash_process` and completion notifications come from the public `backgroundBash` factory. Automatic foreground-to-background handoff is no longer used.
- The task widget reads native session checkpoints and tracks active delegation calls. RPC and print execution do not require a widget.

The confined LSP adapter still loads the pinned upstream implementation inside a worker. Its module-resolution adapter is confined to that process and does not edit the package. MCP retains the local confined client because its permissions and consent lifecycle are not equivalent to Pi's native MCP configuration.

The separate Codex exact-file backend repair on Linux remains necessary for the existing file-grant contract; see [Linux exact-file grants](#linux-exact-file-grants). Removing Pi patches does not remove that backend requirement.

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

The early syntax check writes evidence in the stage. After staging, the integration gate reuses that syntax result only when the code/config content, Node identity/options and selected SDK manifest/CLI still match. Missing, failed, malformed or outdated evidence runs the syntax check again. Git diff checks and the full test suite always run; tests are never cached.

To run the stages individually:

```bash
STAGE="$(mktemp -d)" &&
node scripts/install.mjs --target "$STAGE/agent" &&
node scripts/doctor.mjs --target "$STAGE/agent" --installed &&
PI_CODING_AGENT_DIR="$STAGE/agent" npm run verify:integration &&
node scripts/install.mjs &&
node scripts/doctor.mjs --installed
```

`PI_PACKAGE_JSON` selects the SDK of the runtime you will use. No separate old-runtime fixture or paste patch is required.

Keep the stage and failure output if a gate fails; do not continue to the live install. Successful installation prints the backup location. Restart Pi with `--no-approve`; an already-running session keeps its old executors. MCP server definitions and provider logins are user-owned and are not invented or copied into the stage. This gate checks fixture-backed services and OS boundaries, not authenticated search or a live PR subscription.

The installer pins `typescript@7.0.2` through Pi's package manager and configures its native LSP entry point by absolute path. No global `tsc`, project dependency or network download on first LSP use is needed. Routing includes TS/TSX and JS/JSX/MJS/CJS with package/Git root markers. The exact old shipped TypeScript definition is migrated; custom servers, other LSP settings and disabled-server preferences remain unchanged. `--no-packages` does not install this server: `doctor --installed` reports it missing.

## `scripts/install.mjs`

Idempotent, Node stdlib only. Before any mutation:

- refuses if the target is a symlink, if source == target, or if one contains the other (comparison on canonical paths, legitimate system aliases such as `/tmp` ↔ `/private/tmp` on macOS resolved, not rejected);
- refuses if a symlink exists anywhere under a managed resource (source or target) — would allow a write outside the target during the copy;
- validates the minimal JSON schema of `settings.json` (source and target) before any write;
- refuses an existing unwritable `settings.json` before backup or copying, and checks its permissions again at activation.

The installer places executable resources under `<target>/packages/pi-agent-config/` and registers that local directory in `settings.json.packages`. `package.json.pi.extensions` lists every shipped entry point explicitly; helper files and tests are not extension entry points. The package contains `extensions/`, `lib/`, `gates/`, agent prompts and the confined worker scripts. `shellPath` points into this protected package.

User agent prompts are also copied to `<target>/agents/`. `settings.json` and `keybindings.json` remain at the agent root. Before migration, the installer backs up both the old resource layout and the package directory. It copies the package, atomically activates its settings, then removes shipped legacy files while preserving personal additions. Exact native extension exclusions prevent duplicate loading if cleanup is interrupted. A failed settings activation leaves the previous legacy entry points in place. The mandatory `-builtin:mcp` exclusion survives personal extension preferences and is checked by `doctor --installed`. `auth.json`, sessions, trust, network policy, MCP configuration, consent data and skills remain user-owned.

The Pi package format handles extension discovery and distribution. The installer still performs the host-specific sandbox configuration and dependency setup; a bare `pi install` does not establish those boundaries. Do not load the development checkout as a personal package while editing it with an agent.

Installation now enables the [strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox): it replaces `shellPath` with the installed Codex adapter, preserving the previous settings in the backup. Restart Pi with `--no-approve`, or use the managed launcher described below, which supplies that native option automatically. File tools and Bash run confined without routine approval prompts. Predefined network hosts are automatic. An exact public HTTP(S) URL supplied by the user can be read by `web_fetch` without another confirmation; its fixed GET worker receives only that destination, without cookies, redirects, uploads or a grant to Bash. `request_network_access` still confirms broader session access to additional public hosts, without widening filesystem access. Notes, Graphify, Git inspection, web helpers, CI queries, LSP and configured local MCP servers use confined executors; delegation inherits only confined capabilities. Dunst remains denied by the local strict dispatcher. Its separate implementation retains consent checks. The parent-only [host operation bridge](docs/ORCHESTRATION.md#one-host-operation) separately confirms bounded Podman, clipboard and process operations. It never opens Bash or delegates host access. Recognized failures are recorded through the existing confined Notes worker. See [MCP and desktop consent](docs/ORCHESTRATION.md#mcp-and-desktop-consent) for approval choices, scope and revocation. Unknown tools remain denied. Stable Codex >=0.155.1 must be installed and its OS sandbox and managed proxy must work. The installer backs up then deletes `tool-policy.json` and its obsolete parser/classifier files. It also retires `extensions/model-fallback/index.ts`: the old `fallback/anthropic-astra` default becomes the source's direct model, while other model preferences and native retry settings stay unchanged. There are no API pings, quota-error rewrites or custom provider switches. Resumed sessions may still name the removed virtual model: select a real model with `/model`. Installing this source does not alter saved sessions. The LSP package remains pinned to 0.4.4 with `extensions: []`, preventing its unconfined hooks from loading alongside the replacement. The confined adapter loads that package inside its worker. Do not remove the package or enable its original extension. Configure local MCP servers in the user-owned `mcp.json` described in [Strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox).

Sequence: validate and merge preferences, back up the existing target into `<target>.backup-<timestamp>/` (created with `0700` permissions), copy the package, activate settings atomically, retire shipped legacy copies while preserving personal additions, then run `pi install <source> --no-approve` for each listed package. String and filtered-object package entries are supported; source-managed packages replace their counterpart by identity (without the `@version`/`@sha` suffix), while personal target packages with no source counterpart are kept.

Options:

```bash
node scripts/install.mjs --target <path>   # default: $PI_CODING_AGENT_DIR or ~/.pi/agent
node scripts/install.mjs --no-packages        # copies files, does not invoke `pi install` (offline mode)
```

A failure of an individual package (`pi install`) is reported but does not block the copy of other resources; the output then makes clear not to treat the installation as a full success.

For Playwright on macOS, see the optional [container browser capability](docs/BROWSER-MCP.md). It avoids native Chrome Crashpad denials through a separately approved, disposable Podman container. Installing the regular package alone neither builds the image nor enables this profile.

### Linux KVM image builds

The installed `request_build_access` tool supports the fixed project entry point `ansible-playbook -i localhost, ansible/build.yml`. It uses a separate Bubblewrap sandbox, exposes only `/dev/kvm` in addition to standard devices, and grants the full native host network after one explicit approval. Writes are limited to `.cache/`, `output/` and private temporary storage; build sources remain read-only. It supports a supervised foreground run of 120 minutes by default, up to 240 minutes. Ordinary Bash permissions remain unchanged.

The host needs accessible KVM, `/usr/bin/bwrap` with `--disable-userns`, `/usr/bin/python3`, and installed build dependencies. The tool checks KVM inside the actual build sandbox before starting Ansible. Install through the normal staging workflow and restart Pi; no Codex rebuild or generic `/dev` grant is needed. `/build-access reset` cancels the operation and clears refusals. See [the capability, network scope and native validation](docs/ORCHESTRATION.md#kvm-image-builds). Source/unit validation alone does not establish hardware availability or a successful RHEL image build.

### Plain `pi` startup on supported runtimes

Use `pi --no-approve` with an upstream launcher. Pi's native option keeps the project untrusted even when no protected project resources exist or a previous trust entry is present. Our `project_trust` handler remains a second integration point; tool guards still refuse a trusted session.

The managed launcher inserts `--no-approve` before a prompt delimiter and rejects `--approve`/`-a`. It does not rewrite the SDK, edit the trust store, or widen tool permissions. Existing processes need a restart: `/reload` cannot undo code loaded earlier in a trusted session.

`pi mcp add`, `pi mcp remove` and MCP help use the native configuration-only parser, which rejects session trust flags. The launcher forwards those arguments unchanged, including the server command after `--`; they do not launch a server. For discovery or calls, use the confined `mcp` tool inside Pi. Native `pi mcp list` connects servers outside this bridge and is not part of this exception.

### Updating a private runtime

A shell launcher pointing into `~/.local/share/pi-runtime/` is not a global npm installation. Enable this repo's updater from a host terminal capable of running the native integration gate:

```bash
node scripts/update-runtime.mjs --install-launcher \
  --package-json /absolute/path/to/node_modules/@earendil-works/pi-coding-agent/package.json
```

The default launcher is `~/.local/bin/pi`; `--launcher <path>` selects another regular file. Activation runs `npm run verify:integration`, verifies that runtime files did not change during the gate, backs up the launcher, then replaces it atomically. The launcher binds the selected Node executable and SDK. Its default agent directory is `PI_CODING_AGENT_DIR` at activation, otherwise `~/.pi/agent`; an explicit environment override remains available for commands such as installation into another target. Ordinary commands execute the native CLI directly, preserving its PID, signals and exit status.

Updater code is copied into `<agent-dir>/runtime-updaters/<sha256>.mjs`, outside the writable source checkout. Only `pi update` commands execute that protected copy, always from the selected agent directory. The checkout remains necessary for the explicit update validation gate; ordinary startup works without it. After changing the updater source, Node installation or agent directory, rerun `--install-launcher` to validate and activate the new selection. An agent directory without the matching updater cannot run update commands. No Pi SDK file is rewritten.

`pi update` installs a newer 1.x release in a separate directory, runs the same gate, checks that candidate files stayed unchanged, and switches only after success. It never patches the candidate or modifies the previous runtime. Failed candidates and logs remain available for diagnosis. Updates to a different major require a compatibility review.

For a legacy patched installation, first enable the managed launcher, then run `pi update --force` from the host to install a fresh published copy even when the version is unchanged. Merely deploying this configuration or changing a launcher does not remove old modifications from an existing runtime. The old directory is retained for recovery.

`pi update --extensions`, package sources and help retain their native handling. `pi update --all` also reconciles extensions after a successful runtime update. The fixed trust option applies to forwarded commands too. Extension settings keep the upstream LSP and Bash entry points filtered; their adapters own activation.

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

`--installed` additionally compares the selected executable boundaries with this source, checks the confined shell path, verifies native package registration and that upstream LSP/Bash entry points are filtered and checks pinned LSP/TypeScript package versions. A stale installed policy or missing worker fails this check. MCP configuration presence is reported separately; it does not prove a server works. This is a deployment-readiness check, not a substitute for the full integration gate.

## Tests

```bash
npm run check            # .mjs syntax (node --check) + whitespace hygiene + git diff --check
npm test                 # standard node:test suite, excludes *.integration.test.*
npm run verify           # syntax + standard suite
npm run verify:integration # syntax + full suite + python3 -m unittest test_gates
```

Both `verify` commands print the path to a private `$TMPDIR/pi-verify-*/result.json` and retain each phase's raw log alongside it. The report records the selected test files, exact commands, exit codes or signals, durations, source/SDK fingerprints and any detected missing SDK prerequisite. A failed check prevents test execution; a change to validation inputs during the run fails the gate. Read the raw log for assertion details or sandbox errors: a generic test failure is not classified as a missing prerequisite. An interrupted process may leave a `running` report, which is never evidence of success.

`npm test` loads `tests/resolve-pi.mjs` via `node --import` for the repo's real suite: this file only redirects the specifiers `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` to the `pi` installation actually found on `PATH` (or `PI_PACKAGE_JSON`), via `node:module.registerHooks` (synchronous hook, same thread — no `data:` URL, no `eval`, no temporary symlink). The found `package.json`'s name is verified (`@earendil-works/pi-coding-agent`) before any use.

Tests that launch the real Codex sandbox (including registered Git inspection and Graphify root selection) and real loopback HTTP live in `*.integration.test.*`. They are not silently skipped inside a restricted shell: the full gate still runs them and fails if the required capability is absent. Standard tests cover the service logic, isolated worker protocols, permission checks and installed resource registration.

In `--integration` mode, each missing external dependency (git, jj, graphify, installed `pi`…) explicitly fails a test rather than silently skipping it (`PI_TEST_INTEGRATION=1`); the number of tests and their status therefore depend on the execution environment — do not hardcode a figure here, read the command's actual output.

`npm run test:integration` also runs `python3 -m unittest test_gates -v` in `gates/pi-orchestrate/` if `python3` and `test_gates.py` are present; otherwise, the absence is explicitly reported (not a silent success).

## Gates (`gates/pi-prek`, `gates/pi-orchestrate/gates.py`)

`extensions/orchestrate/index.ts` invokes the `gates/pi-prek` binary inside the installed package (resolved relative to the extension), unless `PI_GATES_BIN` selects an alternative binary. In both cases it goes through the installed Codex launcher; there is no direct host execution fallback. A gate requiring forbidden filesystem or network access fails. Calling `gates/pi-prek` manually from a host terminal is separate and does not create a sandbox itself.

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
- **Every Linux environment**: the previous layout was validated on native Fedora 44 with Pi 0.99.1, Node 26.9.0 and Codex 0.155.1; that result predates this package migration; Darwin-only tests remain skipped there. This does not validate restricted containers or other kernels. Check the real Codex sandbox before enabling it; unavailable namespace support must remain a failure.
- **Full automation**: this installation copies files and invokes `pi install`, it does not configure model authentication (handled by `pi` itself, never by an export from this repo) nor declared-but-unbundled external dependencies (`skills/cli-code-skills` above).
- **Recovery**: in case of a problem, restore from the `<target>.backup-<timestamp>/` backup created by the installer, never via a `git checkout`/`jj restore` of the target (which may not be a versioned repo).
