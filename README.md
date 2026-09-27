# pi-agent

Config perso de [pi](https://github.com/earendil-works/pi) : délégation à des sous-agents, prompt « chef » pour l'orchestration, mémoire SQLite partagée entre agents.

## Installer

```bash
git clone git@github.com:Destynova2/pi-agent.git ~/.pi/agent
pi            # réinstalle les packages listés dans settings.json
```

`auth.json` (clés API) n'est pas versionné : `pi` le recrée au premier login.

## Utiliser

| Quoi | Comment |
|---|---|
| Déléguer une tâche de bout en bout | `/orchestrate <demande>` : le chef réécrit la demande, taille, délègue à scout / worker / reviewer |
| Déléguer une sous-tâche | outil `subagent` avec `agent: scout\|worker\|reviewer` |
| Noter une décision sans tour modèle | `/note decision <texte>` (kinds : plan, decision, done, blocker, lesson, claim, msg) |
| Parler à un autre agent du projet | `/note msg @pi-1234 <texte>`, livré à son prochain tour |
| Retrouver un ancien prompt | `ctrl+r` |
| Importer l'historique des sessions | `/note import` |
| Carte du code | outil `project_graph`, index automatique au démarrage |
| Surveiller une PR | outil `ci_watch`, réveil sur vert / rouge / mergée |

Les notes vivent dans `<repo>/.agent/notes.db` (jamais commité) et sont mirrorées dans `~/workspace/notes.db`, sauf les prompts bruts.

## Contenu

```
settings.json        packages : pi-simplify, ponytail, pi-lsp, background-bash, emilkowalski/skills
keybindings.json     ctrl+r libéré pour la recherche de prompts
agents/              scout, worker, reviewer (prompts des sous-agents)
extensions/
  orchestrate/       /orchestrate et le prompt chef
  subagent/          outil subagent (single, parallel, chain)
  notes.ts           mémoire SQLite, /note, ctrl+r, inbox inter-agents
  ci-watch/          outil ci_watch
  graphify/          outil project_graph
  web/               web_fetch, web_search
  anthropic-docs-compat/  chemins de la doc pi dans le prompt
lib/                 helpers communs
```

## Tests

```bash
for t in extensions/*/tests/*.test.ts lib/tests/*.test.ts; do node --test "$t"; done
```

Non versionné : `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `npm/node_modules`, `git/`, `bin/`, symlink `skills/cli-code-skills`.
