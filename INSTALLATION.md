# Installation

Ce document décrit comment récupérer ce dépôt ailleurs que dans un répertoire agent pi vivant, puis l'installer.

## Source vs cible

Ce dépôt (`pi-agent`, remote `https://github.com/Destynova2/pi-agent.git`) est une **source de configuration**, pas un état installé. `scripts/install.mjs` refuse explicitement toute cible identique ou imbriquée avec la source (chemins comparés en forme canonique, liens symboliques résolus) : source et cible doivent être deux répertoires distincts et non imbriqués, sinon l'installeur s'arrête avant toute écriture.

**État actuel** : au moment d'écrire ce document, la copie locale de ce dépôt (`~/.pi/agent`) est à la fois la source de travail *et* un agent pi en fonctionnement — elle contient des modifications non commitées et non poussées vers `origin` (voir `git status`). Cloner `origin` aujourd'hui **ne récupère pas** ces modifications. Ce document décrit la procédure pour une fois qu'elles seront publiées ; en attendant, testez depuis cette copie locale directement (elle joue le rôle de source pour `scripts/install.mjs --target <ailleurs>`).

Une fois les modifications publiées, cloner dans un répertoire séparé, jamais directement dans le répertoire agent visé :

```bash
git clone https://github.com/Destynova2/pi-agent.git ~/src/pi-agent
cd ~/src/pi-agent
```

## Prérequis

- Node.js `>=22.19` (`package.json` → `engines.node`). `node:sqlite` doit être disponible (vérifié par `doctor`, natif depuis Node 22.5+, actif par défaut à partir de 22.19).
- [`pi`](https://github.com/earendil-works/pi) installé et sur `PATH`. `settings.json` de ce dépôt indique `lastChangelogVersion: 0.87.1` — vérifiez votre version réelle avec `pi --version` avant d'installer les packages listés (peut différer).
- `git`, `curl`.
- Optionnels, diagnostiqués mais non bloquants : `graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`.

Ce dépôt n'a **aucune dépendance npm** (`scripts/` et `tests/` sont en stdlib Node pur, voir description de `package.json`). Il n'y a pas de `package-lock.json` : `npm ci` échouerait faute de lockfile et n'a de toute façon rien à installer.

## Quickstart

```bash
node scripts/doctor.mjs            # diagnostic avant d'installer quoi que ce soit
node scripts/install.mjs --target ~/.pi/agent-test   # installe vers une cible de test, jamais la source
node scripts/doctor.mjs --target ~/.pi/agent-test
```

Pour installer vers la cible par défaut de `pi` (`$PI_CODING_AGENT_DIR` ou `~/.pi/agent`) :

```bash
node scripts/install.mjs
```

## `scripts/install.mjs`

Idempotent, stdlib Node uniquement. Avant toute mutation :

- refuse si la cible est un lien symbolique, si source == cible, ou si l'une contient l'autre (comparaison sur chemins canoniques, alias système légitimes comme `/tmp` ↔ `/private/tmp` sur macOS résolus, pas rejetés) ;
- refuse si un lien symbolique existe n'importe où sous une ressource gérée (source ou cible) — éviterait une écriture hors cible pendant la copie ;
- valide le schéma JSON minimal de `settings.json` (source et cible) avant toute écriture.

Répertoires/fichiers gérés (`MANAGED_DIRS`/`MANAGED_FILES` dans `scripts/install.mjs`) : `agents/`, `extensions/`, `lib/`, `tools/`, `keybindings.json`, `settings.json`. **Jamais touchés** : `auth.json`, `sessions/`, `models-store.json`, `trust.json`, ni aucun fichier hors de cette liste (y compris `skills/`, voir plus bas).

Séquence : sauvegarde de la cible existante dans `<cible>.backup-<horodatage>/` (créé avec permissions `0700`), puis copie fichier par fichier (jamais de suppression de répertoire cible : tout ajout personnel dans un répertoire géré survit à une réinstallation), puis fusion de `settings.json` (les paquets gérés par la source remplacent leur équivalent par identité — sans le suffixe `@version`/`@sha` — dans la cible ; les paquets personnels de la cible sans équivalent source sont conservés), puis `pi install <source> --no-approve` pour chaque paquet listé.

Options :

```bash
node scripts/install.mjs --target <chemin>   # défaut: $PI_CODING_AGENT_DIR ou ~/.pi/agent
node scripts/install.mjs --no-packages        # copie les fichiers, n'invoque pas `pi install` (mode hors-ligne)
```

Un échec d'un paquet individuel (`pi install`) est rapporté mais ne bloque pas la copie des autres ressources ; la sortie précise alors de ne pas considérer l'installation comme un succès complet.

### Restauration après un problème

La sauvegarde précédente reste dans `<cible>.backup-<horodatage>/` — restaurez-la manuellement (`cp -a <backup>/<entrée> <cible>/<entrée>`), entrée par entrée si besoin. Ce n'est **pas** un `git checkout` ni un `jj restore` : la cible d'installation n'est pas nécessairement un dépôt Git/jj, et l'installeur ne suppose jamais qu'elle en est un.

## `scripts/doctor.mjs`

```bash
node scripts/doctor.mjs [--target <chemin>] [--strict]
```

Vérifie la version de Node (contre `engines.node` de `package.json`), la disponibilité de `node:sqlite`, les commandes requises (`git`, `curl`, `pi`) et optionnelles (`graphify`, `jj`, `prek`, `gitleaks`, `python3`, `claude`, `gh`), ainsi que la présence exécutable de `gates/pi-prek` dans la cible. `--strict` fait échouer aussi sur un outil optionnel manquant (par défaut, avertissement seulement). Ne lit ni n'affiche jamais `auth.json`.

## Tests

```bash
npm run check            # syntaxe .mjs (node --check) + hygiène espaces + git diff --check
npm test                 # suite node:test standard, exclut *.integration.test.*
npm run test:integration # suite complète (rien exclu) + python3 -m unittest test_gates
```

`npm test` charge `tests/resolve-pi.mjs` via `node --import` pour la suite réelle du dépôt : ce fichier redirige uniquement les specifiers `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` et `typebox` vers l'installation `pi` réellement trouvée sur `PATH` (ou `PI_PACKAGE_JSON`), via `node:module.registerHooks` (hook synchrone, même thread — pas de `data:` URL, pas d'`eval`, pas de lien symbolique temporaire). Le nom du `package.json` trouvé est vérifié (`@earendil-works/pi-coding-agent`) avant tout usage.

En mode `--integration`, chaque dépendance externe absente (git, jj, graphify, `pi` installé…) fait échouer un test explicitement plutôt que de le sauter silencieusement (`PI_TEST_INTEGRATION=1`) ; le nombre de tests et leur statut dépendent donc de l'environnement d'exécution — ne pas figer de chiffre ici, lire la sortie réelle de la commande.

`npm run test:integration` exécute en plus `python3 -m unittest test_gates -v` dans `gates/pi-orchestrate/` si `python3` et `test_gates.py` sont présents ; sinon, l'absence est annoncée explicitement (pas un succès silencieux).

## Gates (`gates/pi-prek`, `gates/pi-orchestrate/gates.py`)

`extensions/orchestrate/index.ts` invoque le binaire `gates/pi-prek` copié dans le répertoire agent (résolu via `getAgentDir()`), sauf si la variable d'environnement `PI_GATES_BIN` est définie (échappatoire pour les tests ou une installation alternative du binaire de gates).

`gates/pi-prek` est un wrapper POSIX (`#!/bin/sh`) qui résout son propre emplacement réel (liens symboliques compris) puis exécute `python3 gates/pi-orchestrate/gates.py` à côté de lui — aucun `$HOME` ni nom d'utilisateur codé en dur.

`gates.py` exige :

- un dépôt colocaté **jj + Git** (`.git` en répertoire, pas en fichier gitlink) ;
- une politique par projet dans `~/.config/pi-orchestrate/projects/<sha256(chemin_racine_réel)[:20]>.json`, avec `root` (chemin absolu réel de la racine, doit correspondre exactement, `realpath` compris) et `required` (liste non vide de commandes obligatoires en mode `full`) — voir `gates/pi-orchestrate/example-policy.json`, qui documente le format mais n'est **jamais lu ni créé automatiquement** ; copiez-le manuellement et adaptez-le ;
- `prek` et `gitleaks` installés (diagnostiqués comme optionnels par `doctor`, mais requis pour que les gates fonctionnent) ;
- aucune variable de contournement (`SKIP`, `PREK_SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`, `GITLEAKS_CONFIG`, `GITLEAKS_CONFIG_TOML`) dans l'environnement.

Trois modes : `quick` (hooks `pre-commit` seulement), `full` (tous les stages + commandes de la politique, exécutés dans une copie clonée à part, produit un reçu `approved.json` dans le cache si tout passe), `dry-run`. **`dry-run` n'est pas sans effet** : il exécute réellement `prek run --all-files --stage <stage> --dry-run` sur la racine du dépôt elle-même (pas une copie isolée), contrairement au mode `full` qui travaille sur un clone jetable — ne pas le considérer comme une simulation totalement inerte.

## `skills/cli-code-skills` : dépendance externe non fournie, restauration manuelle

`settings.json` (clé `packages`) **ne peut pas** déclarer `cli-code-skills` : ce dépôt externe n'a ni `skills/` à sa racine ni manifeste `package.json` reconnu par la découverte de paquets de `pi` (`hasAnyDir=false`, vérifié empiriquement — 0 skill chargé via `pi install`). La seule intégration qui fonctionne est un répertoire (ou lien symbolique) sous le répertoire conventionnel de skills de l'agent (`skills/`). `scripts/install.mjs` ne gère jamais `skills/` (absent de `MANAGED_DIRS`) : un lien symbolique existant y survit intact à toute installation/réinstallation, sans double activation.

Ce dépôt ne fournit **aucun instantané** de `cli-code-skills` et l'installeur ne l'installe pas automatiquement. Si vous voulez ces skills, restaurez-les manuellement depuis le dépôt connu, épinglé à un commit précis, sous la garde que la destination n'existe pas déjà :

```bash
DEST="<répertoire agent cible>/skills/cli-code-skills"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "refus : $DEST existe déjà (fichier, dossier ou lien symbolique) — ne pas écraser" >&2
else
  git clone https://github.com/Destynova2/cli-code-skills.git "$DEST"
  git -C "$DEST" checkout --detach 7541b6938e18ffc78065800060444bb623aecd3c
fi
```

Remplacez `<répertoire agent cible>` par votre propre chemin d'installation ; ne copiez pas un chemin `/Users/...` d'une machine tierce. Cette étape est une dépendance externe déclarée dans cette documentation, pas une garantie livrée avec le dépôt : l'installation décrite plus haut ne l'exécute pas pour vous.

## Ce que cette documentation ne garantit pas

- **Portabilité Linux** : non validée. Une tentative d'exécution dans un conteneur type « e2e-runner » a échoué faute d'image Node téléchargée ; seule une exécution macOS a été vérifiée de bout en bout pour ce document. Considérez Linux comme non testé tant qu'une validation explicite n'a pas été faite.
- **Automatisation complète** : cette installation copie des fichiers et invoque `pi install`, elle ne configure pas l'authentification aux modèles (gérée par `pi` lui-même, jamais par un export de ce dépôt) ni les dépendances externes déclarées mais non fournies (`skills/cli-code-skills` ci-dessus).
- **Restauration** : en cas de problème, restaurez depuis la sauvegarde `<cible>.backup-<horodatage>/` créée par l'installeur, jamais par un `git checkout`/`jj restore` de la cible (qui peut ne pas être un dépôt versionné).
