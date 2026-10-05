# pi-agent

Personal config for [pi](https://github.com/earendil-works/pi): delegation to sub-agents, "chef" prompt for orchestration, SQLite memory shared between agents.

This repo is a **source** to install, not a live runtime. See [INSTALLATION.md](INSTALLATION.md) to clone this repo elsewhere and install it cleanly into a pi agent directory (never into this repo itself).

## Prerequisites

- Node.js `>=22.19` with `node:sqlite` (see `package.json`)
- [`pi`](https://github.com/earendil-works/pi) `>=0.99.1` installed and on `PATH`; see [runtime compatibility and validation](INSTALLATION.md#runtime-compatibility). `lastChangelogVersion` is a UI read marker, not a version pin.
- `git`, `curl`, Codex >=0.155.1 with a working native sandbox

`node scripts/doctor.mjs` diagnoses the environment (required + optional: `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`, `podman`). Binary presence does not verify a running Podman VM or GPU access.

## Usage

| What | How |
|---|---|
| Adapt delegation automatically | Ask normally: work starts direct and splits when useful; `/orchestrate <request>` remains optional |
| Delegate or resume a subtask | `subagent` with `agent: scout\|worker\|reviewer`; reuse the returned `resume` ID for a follow-up |
| Inspect tool confinement | `/confined-tools`: available executors and approval boundaries |
| Preserve all parts of a request | `task_checkpoint` records requirements and verification evidence in the session; `/task-status` shows them after reload, compaction or restart |
| Retry a denied write | `request_command_access`: [one confirmed command with exact additional paths](docs/ORCHESTRATION.md#one-command-filesystem-access) |
| Request local service access | `request_host_access`: [one confirmed host operation](docs/ORCHESTRATION.md#one-host-operation), without opening Bash |
| Diagnose Podman | `podman_list`, `podman_inspect`, `podman_logs` (bounded, last hour), `podman_machine_list` through `request_host_access` |
| List cached models without starting Pi | `model_catalog`: metadata only, no credential resolution or quota probe |
| Review recorded failures | `note_list` with `kind: blocker` or `done`; [sanitized incident memory](docs/ORCHESTRATION.md#incident-records) |
| Read a URL you supplied | `web_fetch` or `/web <url>`: exact public GET without another confirmation; no permission for Bash or uploads |
| Review experimental Metal access | [Qualified backend and one-command GPU approval](experiments/metal/README.md); macOS on Apple Silicon only, disabled until separately installed; Linux GPU backend not implemented |
| Allow another public host | `request_network_access`: filesystem confinement stays unchanged |
| Inspect Git without general shell access | `git_inspect`: status, diff, log or files |
| Authorize Git writes for a repository | `git_access`: [branch, explicit files and commit with remembered consent; push confirmed separately](docs/ORCHESTRATION.md#git-operation-consent) |
| Revoke repository Git consent | `/git-access permissions` |
| Note a decision without a model turn | `/btw decision <text>` (kinds: plan, decision, done, blocker, lesson, claim) |
| Talk to another project agent | `/btw [@agent] <text>`: routed by @name, otherwise by claimed path, otherwise broadcast; delivered on its next turn or between tool calls if it's running |
| Find an old prompt | `ctrl+r` |
| Import session history | `/btw import` |
| Code map | `project_graph` tool, auto-indexed at startup |
| Watch a PR | `ci_watch` or `/watch`: jailed queries, host-side timers |
| Use language servers | `lsp` and `/lsp`: jailed servers, previews, edits and diagnostics |
| Use local MCP servers | `mcp`: confined stdio servers with [once/session/project consent](docs/ORCHESTRATION.md#mcp-and-desktop-consent) |
| Control Mac applications | `dunst` is host automation, not a confined capability; denied by this jail |
| Revoke MCP or desktop consent | `/mcp permissions [server]` or `/dunst permissions` |

Notes live in `<repo>/.agent/notes.db` (never committed) and are mirrored to `~/workspace/notes.db`, except raw prompts. The first turn loads the last 20 project notes (at most 12,000 characters), even without note tools. Prompt excerpts are not full history: consult native Pi sessions for complete requirements and previous answers. No separate memory model call is made.

Installing these adapters does not activate them in an already-running session; restart Pi after deployment. The upstream LSP extension stays filtered out: its replacement runs the same lifecycle inside Codex. MCP support is local stdio only. `web_search` uses the existing Claude login and quota, but authenticated live search still needs validation; no paid model call was used for testing. See [Strict tool sandbox](docs/ORCHESTRATION.md#strict-tool-sandbox) for boundaries. Model transport, trusted host internals, the explicitly confirmed host operation bridge are not jailed. Dunst remains denied by the local strict dispatcher.

See [Latency and context](docs/PERFORMANCE.md) for measured startup/context costs, Jcode comparisons, and native batching of queued follow-ups.

## Contents

```
settings.json        packages: pi-simplify, ponytail, pi-lsp, TypeScript, background-bash, emilkowalski/skills
keybindings.json     ctrl+r freed for prompt search
agents/              scout, worker, reviewer (sub-agent prompts)
extensions/
  orchestrate/       /orchestrate and the chef prompt; gates via gates/pi-prek
  subagent/          bounded single/parallel/chain delegation and native session resume
  tool-policy/       confined-executor dispatcher, /confined-tools (no legacy policy)
  git-inspect/       fixed-argument Git inspection
  notes.ts           SQLite memory, /btw, ctrl+r, inter-agent inbox
  confined-lsp/      jailed upstream LSP lifecycle and guarded edits
  mcp/               configured local MCP stdio servers
  dunst/             host application control (denied by the strict dispatcher)
  ci-watch/          ci_watch tool
  graphify/          project_graph tool
  web/               web_fetch, web_search
  anthropic-docs-compat/  pi doc paths in the prompt
lib/                 shared helpers
gates/
  pi-prek              POSIX wrapper (resolves gates.py via symlink)
  pi-orchestrate/      gates.py, test_gates.py, example-policy.json
scripts/             install.mjs, doctor.mjs, test.mjs, check.mjs (installer/diagnostic, Node stdlib)
tests/               script tests (node:test)
```

Not versioned: `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `npm/node_modules`, `git/`, `bin/`, `skills/cli-code-skills` symlink (see INSTALLATION.md).

## Development

```bash
npm run check           # .mjs syntax + whitespace hygiene + git diff --check
npm test                # standard suite (node:test), excluding *.integration.test.*
npm run verify         # standard completion gate: syntax + standard tests
npm run verify:integration  # host gate: syntax + full suite + Python gates
```

No versioned `node_modules`: Node stdlib only for `scripts/` and `tests/`, `npm ci` has nothing to install (no `package-lock.json`).

Run `node scripts/doctor.mjs --installed` to detect missing or stale deployed executors and LSP packages. This is a deployment check, not proof that every external service works. See [INSTALLATION.md](INSTALLATION.md#validate-before-activating) for staged validation before activation.
