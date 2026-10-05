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
- [`pi`](https://github.com/earendil-works/pi) installed and on `PATH`. This repo's `settings.json` states `lastChangelogVersion: 0.87.1` — check your actual version with `pi --version` before installing the listed packages (may differ).
- `git`, `curl`, Codex >=0.155.1 with a working OS sandbox and managed proxy.
- Optional, diagnosed but non-blocking: `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`. Podman must also have a working connection/VM for container operations; binary presence alone is insufficient.

This repo has **no npm dependencies** (`scripts/` and `tests/` are pure Node stdlib, see `package.json` description). There is no `package-lock.json`: `npm ci` would fail for lack of a lockfile and has nothing to install anyway.

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

## `scripts/install.mjs`

Idempotent, Node stdlib only. Before any mutation:

- refuses if the target is a symlink, if source == target, or if one contains the other (comparison on canonical paths, legitimate system aliases such as `/tmp` ↔ `/private/tmp` on macOS resolved, not rejected);
- refuses if a symlink exists anywhere under a managed resource (source or target) — would allow a write outside the target during the copy;
- validates the minimal JSON schema of `settings.json` (source and target) before any write.

Managed directories/files (`MANAGED_DIRS`/`MANAGED_FILES` in `scripts/install.mjs`): `agents/`, `extensions/`, `lib/`, `gates/`, `scripts/codex-shell.mjs`, `scripts/codex-tool.mjs`, `scripts/codex-network.mjs`, `scripts/metal-backend.mjs`, `scripts/web-read-worker.mjs`, `scripts/git-operation.mjs`, `scripts/git-hook-guard.mjs`, `scripts/git-hooks/`, `scripts/confined-tool.mjs`, `scripts/confined-lsp-worker.mjs`, `keybindings.json`, `settings.json`. The shell launcher retains its executable mode and is backed up on reinstall; other personal scripts are not managed. **Never touched**: `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `network-policy.json`, `mcp.json`, `mcp-approvals/`, nor any file outside this list except the explicitly retired legacy policy files (including `skills/`, see below).

Installation now enables the [strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox): it replaces `shellPath` with the installed Codex adapter, preserving the previous settings in the backup. With the [pinned trust-order patch](#plain-pi-startup-on-supported-runtimes) installed, restart Pi normally. `--no-approve` is only a workaround for an unpatched runtime. File tools and Bash run confined without routine approval prompts. Predefined network hosts are automatic. An exact public HTTP(S) URL supplied by the user can be read by `web_fetch` without another confirmation; its fixed GET worker receives only that destination, without cookies, redirects, uploads or a grant to Bash. `request_network_access` still confirms broader session access to additional public hosts, without widening filesystem access. Notes, Graphify, Git inspection, web helpers, CI queries, LSP and configured local MCP servers use confined executors; delegation inherits only confined capabilities. Dunst is separate host automation: observation consent can be remembered, while actions retain fresh exact confirmation. The parent-only [host operation bridge](docs/ORCHESTRATION.md#one-host-operation) separately confirms bounded Podman, clipboard and process operations. It never opens Bash or delegates host access. Recognized failures are recorded through the existing confined Notes worker. See [MCP and desktop consent](docs/ORCHESTRATION.md#mcp-and-desktop-consent) for approval choices, scope and revocation. Unknown tools remain denied. Stable Codex >=0.155.1 must be installed and its OS sandbox and managed proxy must work. The installer backs up then deletes `tool-policy.json` and its obsolete parser/classifier files. The LSP package remains pinned to 0.4.4 with `extensions: []`, preventing its unconfined hooks from loading alongside the replacement. The confined adapter loads that package inside its worker. Do not remove the package or enable its original extension. Configure local MCP servers in the user-owned `mcp.json` described in [Strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox).

Sequence: back up the existing target into `<target>.backup-<timestamp>/` (created with `0700` permissions), then copy file by file (never deletes a target directory: any personal addition in a managed directory survives a reinstall), then merge `settings.json` (string and filtered-object package entries are supported; packages managed by the source replace their counterpart by identity — without the `@version`/`@sha` suffix — in the target; personal target packages with no source counterpart are kept), then `pi install <source> --no-approve` for each listed package.

Options:

```bash
node scripts/install.mjs --target <path>   # default: $PI_CODING_AGENT_DIR or ~/.pi/agent
node scripts/install.mjs --no-packages        # copies files, does not invoke `pi install` (offline mode)
```

A failure of an individual package (`pi install`) is reported but does not block the copy of other resources; the output then makes clear not to treat the installation as a full success.

### Plain `pi` startup on supported runtimes

Unpatched Pi 0.99.1, 1.0.1 and 1.0.2 skip personal `project_trust` handlers when a directory has no protected project resources. It marks that directory trusted, which the confined-tool broker correctly refuses. `defaultProjectTrust: "never"` does not fix that early return.

After backing up the Pi package, apply the pinned runtime correction:

```bash
node scripts/patch-project-trust.mjs <Pi-package-root>
```

This changes the CLI startup condition and moves the empty-project shortcut after personal trust handlers in both the bundled CLI and unbundled runtime. Our existing handler then declines host-side project resources automatically, including previously trusted projects. Tool guards, native explicit CLI overrides, and the no-handler fallback remain unchanged. No alias, recurring flag, or trust-store edit is needed.

The patch accepts only exact known Pi 0.99.1, 1.0.1 and 1.0.2 artifacts, validates every target before writing, and is idempotent. The 1.0.1/1.0.2 pins were matched against registry tarballs with SHA-512 integrity checks, not inferred from old filenames. Unknown versions or modified artifacts are refused. It does not touch the paste patch. The paste mitigation also supports the verified 1.0.2 artifacts.

For the separate bracketed-paste keepalive mitigation, back up both the coding-agent package and its resolved `pi-tui` dependency, then apply `node scripts/patch-paste.mjs <Pi-package-root>`. Supported versions are pinned in `patches/paste-keepalive.mjs`, including 1.0.1. Already-patched content is reverse-validated against its pristine hash. This mitigation re-enables paste mode on TTYs; it does not establish the original cause of every paste failure. Upgrades replace both runtime patches. Never force old hashes or remove sandbox guards. The configuration installer does not modify the Pi runtime; after a Pi upgrade, revalidate runtime compatibility instead of forcing this patch onto a new version.

Already-running processes need one normal restart, not `/reload`: reload retains their old trust state and cannot undo host code that already ran. Quit Pi, then use `pi --resume` in the same project and select the existing conversation. Future launches use plain `pi`.

### Recovering after a problem

The previous backup remains at `<target>.backup-<timestamp>/` — restore it manually (`cp -a <backup>/<entry> <target>/<entry>`), entry by entry if needed. This is **not** a `git checkout` nor a `jj restore`: the install target is not necessarily a Git/jj repo, and the installer never assumes it is one.

## `scripts/doctor.mjs`

```bash
node scripts/doctor.mjs [--target <path>] [--strict]
```

Checks the Node version (against `engines.node` in `package.json`), `node:sqlite` availability, required commands (`git`, `curl`, `pi`, `codex`) and optional ones (`graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`), as well as the executable presence of `gates/pi-prek` in the target. `--strict` also fails on a missing optional tool (warning only by default). Never reads or displays `auth.json`.

## Tests

```bash
npm run check            # .mjs syntax (node --check) + whitespace hygiene + git diff --check
npm test                 # standard node:test suite, excludes *.integration.test.*
npm run test:integration # full suite (nothing excluded) + python3 -m unittest test_gates
```

`npm test` loads `tests/resolve-pi.mjs` via `node --import` for the repo's real suite: this file only redirects the specifiers `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` to the `pi` installation actually found on `PATH` (or `PI_PACKAGE_JSON`), via `node:module.registerHooks` (synchronous hook, same thread — no `data:` URL, no `eval`, no temporary symlink). The found `package.json`'s name is verified (`@earendil-works/pi-coding-agent`) before any use.

In `--integration` mode, each missing external dependency (git, jj, graphify, installed `pi`…) explicitly fails a test rather than silently skipping it (`PI_TEST_INTEGRATION=1`); the number of tests and their status therefore depend on the execution environment — do not hardcode a figure here, read the command's actual output.

`npm run test:integration` also runs `python3 -m unittest test_gates -v` in `gates/pi-orchestrate/` if `python3` and `test_gates.py` are present; otherwise, the absence is explicitly reported (not a silent success).

## Gates (`gates/pi-prek`, `gates/pi-orchestrate/gates.py`)

`extensions/orchestrate/index.ts` invokes the `gates/pi-prek` binary copied into the agent directory (resolved via `getAgentDir()`), unless the `PI_GATES_BIN` environment variable is set (escape hatch for tests or an alternative gates binary installation).

`gates/pi-prek` is a POSIX wrapper (`#!/bin/sh`) that resolves its own real location (symlinks included) then runs `python3 gates/pi-orchestrate/gates.py` next to it — no hardcoded `$HOME` or username.

`gates.py` requires:

- a colocated **jj + Git** repo (`.git` as a directory, not a gitlink file);
- a per-project policy at `~/.config/pi-orchestrate/projects/<sha256(real_root_path)[:20]>.json`, with `root` (real absolute path of the root, must match exactly, `realpath` included) and `required` (non-empty list of mandatory commands in `full` mode) — see `gates/pi-orchestrate/example-policy.json`, which documents the format but is **never read or created automatically**; copy it manually and adapt it;
- `prek` and `gitleaks` installed (diagnosed as optional by `doctor`, but required for the gates to work);
- no bypass environment variable (`SKIP`, `PREK_SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`, `GITLEAKS_CONFIG`, `GITLEAKS_CONFIG_TOML`) set.

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
