# pi-agent

Config perso de [pi](https://github.com/earendil-works/pi) : délégation à des sous-agents, prompt « chef » pour l'orchestration, mémoire SQLite partagée entre agents.

Ce dépôt est une **source** à installer, pas un runtime en place. Voir [INSTALLATION.md](INSTALLATION.md) pour cloner ce dépôt ailleurs et l'installer proprement vers un répertoire agent pi (jamais dans ce dépôt lui-même).

## Prérequis

- Node.js `>=22.19` avec `node:sqlite` (voir `package.json`)
- [`pi`](https://github.com/earendil-works/pi) installé et sur `PATH` (`lastChangelogVersion` dans `settings.json` : `0.87.1`, à vérifier contre votre version réelle)
- `git`, `curl`

`node scripts/doctor.mjs` diagnostique l'environnement (requis + optionnels : `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`).

## Utiliser

| Quoi | Comment |
|---|---|
| Déléguer une tâche de bout en bout | `/orchestrate <demande>` : le chef réécrit la demande, taille, délègue à scout / worker / reviewer |
| Déléguer une sous-tâche | outil `subagent` avec `agent: scout\|worker\|reviewer` |
| Noter une décision sans tour modèle | `/btw decision <texte>` (kinds : plan, decision, done, blocker, lesson, claim) |
| Parler à un autre agent du projet | `/btw [@agent] <texte>` : routé par @nom, sinon par chemin revendiqué (claim), sinon broadcast ; livré à son prochain tour ou entre deux outils s'il tourne |
| Retrouver un ancien prompt | `ctrl+r` |
| Importer l'historique des sessions | `/btw import` |
| Carte du code | outil `project_graph`, index automatique au démarrage |
| Surveiller une PR | outil `ci_watch`, réveil sur vert / rouge / mergée |

Les notes vivent dans `<repo>/.agent/notes.db` (jamais commité) et sont mirrorées dans `~/workspace/notes.db`, sauf les prompts bruts.

## Contenu

```
settings.json        packages : pi-simplify, ponytail, pi-lsp, background-bash, emilkowalski/skills
keybindings.json     ctrl+r libéré pour la recherche de prompts
agents/              scout, worker, reviewer (prompts des sous-agents)
extensions/
  orchestrate/       /orchestrate et le prompt chef ; gates via gates/pi-prek
  subagent/          outil subagent (single, parallel, chain)
  notes.ts           mémoire SQLite, /btw, ctrl+r, inbox inter-agents
  ci-watch/          outil ci_watch
  graphify/          outil project_graph
  web/               web_fetch, web_search
  anthropic-docs-compat/  chemins de la doc pi dans le prompt
lib/                 helpers communs
gates/
  pi-prek              wrapper POSIX (résout gates.py par lien symbolique)
  pi-orchestrate/      gates.py, test_gates.py, example-policy.json
scripts/             install.mjs, doctor.mjs, test.mjs, check.mjs (installeur/diagnostic, stdlib Node)
tests/               tests des scripts (node:test)
```

Non versionné : `auth.json`, `sessions/`, `models-store.json`, `trust.json`, `npm/node_modules`, `git/`, `bin/`, symlink `skills/cli-code-skills` (voir INSTALLATION.md).

## Développement

```bash
npm run check           # syntaxe .mjs + hygiène espaces + git diff --check
npm test                # suite standard (node:test), hors *.integration.test.*
npm run test:integration  # suite complète + gates Python (échoue dur si une dépendance externe manque)
```

Pas de `node_modules` versionné : stdlib Node uniquement pour `scripts/` et `tests/`, `npm ci` n'a rien à installer (aucun `package-lock.json`).

Voir [INSTALLATION.md](INSTALLATION.md) pour le détail de l'installeur, du diagnostic et des gates.
