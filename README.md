# pi-agent

Config perso de [pi](https://github.com/earendil-works/pi) : `~/.pi/agent`.

- `settings.json` : packages (pi-simplify, ponytail, pi-lsp, background-bash, emilkowalski/skills), LSP.
- `extensions/` : subagent, orchestrate (prompt chef), ci-watch, graphify, web, notes (mémoire SQLite partagée), anthropic-docs-compat.
- `agents/` : scout, worker, reviewer pour `subagent`.
- `lib/` : helpers communs, avec tests (`node --test lib/tests/*.test.ts`).
- `keybindings.json` : ctrl+r libéré pour la recherche de prompts.

Non versionné : `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `npm/node_modules`, `git/`, `bin/`, symlink `skills/cli-code-skills`.

Restaurer : cloner dans `~/.pi/agent`, puis `pi` réinstalle les packages au démarrage.
