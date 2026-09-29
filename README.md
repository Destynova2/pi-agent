# pi-agent

Personal config for [pi](https://github.com/earendil-works/pi): delegation to sub-agents, "chef" prompt for orchestration, SQLite memory shared between agents.

This repo is a **source** to install, not a live runtime. See [INSTALLATION.md](INSTALLATION.md) to clone this repo elsewhere and install it cleanly into a pi agent directory (never into this repo itself).

## Prerequisites

- Node.js `>=22.19` with `node:sqlite` (see `package.json`)
- [`pi`](https://github.com/earendil-works/pi) installed and on `PATH` (`lastChangelogVersion` in `settings.json`: `0.87.1`, check against your actual version)
- `git`, `curl`

`node scripts/doctor.mjs` diagnoses the environment (required + optional: `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`).

## Usage

| What | How |
|---|---|
| Delegate an end-to-end task | `/orchestrate <request>`: the chef rewrites the request, sizes it, delegates to scout / worker / reviewer |
| Delegate a subtask | `subagent` tool with `agent: scout\|worker\|reviewer` |
| Note a decision without a model turn | `/btw decision <text>` (kinds: plan, decision, done, blocker, lesson, claim) |
| Talk to another project agent | `/btw [@agent] <text>`: routed by @name, otherwise by claimed path, otherwise broadcast; delivered on its next turn or between tool calls if it's running |
| Find an old prompt | `ctrl+r` |
| Import session history | `/btw import` |
| Code map | `project_graph` tool, auto-indexed at startup |
| Watch a PR | `ci_watch` tool, wakes on green / red / merged |

Notes live in `<repo>/.agent/notes.db` (never committed) and are mirrored to `~/workspace/notes.db`, except raw prompts.

## Contents

```
settings.json        packages: pi-simplify, ponytail, pi-lsp, background-bash, emilkowalski/skills
keybindings.json     ctrl+r freed for prompt search
agents/              scout, worker, reviewer (sub-agent prompts)
extensions/
  orchestrate/       /orchestrate and the chef prompt; gates via gates/pi-prek
  subagent/          subagent tool (single, parallel, chain)
  notes.ts           SQLite memory, /btw, ctrl+r, inter-agent inbox
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
npm run test:integration  # full suite + Python gates (hard failure if an external dependency is missing)
```

No versioned `node_modules`: Node stdlib only for `scripts/` and `tests/`, `npm ci` has nothing to install (no `package-lock.json`).

See [INSTALLATION.md](INSTALLATION.md) for details on the installer, diagnostics, and gates.
