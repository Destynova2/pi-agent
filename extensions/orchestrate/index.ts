import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../lib/process.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { recommendedWorkspace, workspaceHint } from "./workspace.ts";

/**
 * Prefix for `/orchestrate <request>`. The current agent acts as the chef:
 * it sizes the task, delegates through the `subagent` tool when that pays off,
 * gets an independent review from another model family, and stops cleanly.
 */
const ORCHESTRATE_PROMPT = `Tu prends en charge la demande ci-dessous de bout en bout. Tu es le chef : tu décides, tu délègues quand cela paie, tu ne bluffes jamais.

Ta première réponse commence par la demande réécrite en six lignes : CONTEXTE, TÂCHE, WRITE-SET, CONTRAINTES, VÉRIF (commande ou critère observable), SORTIE. Ce n'est pas une étape de travail, c'est le texte que tu passeras aux workers. Une ligne que tu ne peux pas remplir sans deviner : pose la question, toutes en une fois, et arrête-toi là. Exception : audit ou revue en lecture seule, ne demande rien, fixe VÉRIF = constats avec file:line, SORTIE = rapport sans modification appliquée. Si la demande contient plusieurs tâches dont le write-set ou la vérification diffèrent, écris un bloc KERNEL par tâche, numérote-les, et fais valider la sélection et l'ordre avant d'agir ; des tâches qui partagent fichiers et vérification restent un seul bloc.

Taille d'abord la tâche, puis choisis le tier :
- S (1-2 fichiers, changement local, compris en quelques lectures) : fais-le toi-même. Pas de délégation.
- M/L (plusieurs fichiers ou modules, exploration nécessaire, ou plusieurs sous-tâches indépendantes) : utilise l'outil \`subagent\` :
  1. \`scout\` (lecture seule, modèle rapide) pour obtenir le contexte et un write-set proposé. Lance plusieurs scouts en parallèle si les zones sont disjointes.
  2. Écris un plan court : sous-tâches, write-set de chacune (disjoints), vérification attendue.
  3. \`worker\` par sous-tâche, en parallèle quand les write-sets sont disjoints, sinon en chaîne. Donne à chaque worker sa tâche, son write-set et la commande de vérification.
  4. \`reviewer\` (autre famille de modèle) sur le diff, en lui donnant la tâche, le write-set, et les preuves du worker. Après des workers parallèles, donne-lui l'union des write-sets et dis-lui quels fichiers appartiennent à quelle sous-tâche, sinon il verra du hors-scope. Une seule correction par un worker si DENY, puis re-review.
  5. Apoptose : deuxième DENY sur le même point, ESCALATE, ou blocage sans progrès → arrête, laisse le travail en l'état, et rapporte précisément.
Si l'outil \`subagent\` n'est pas disponible, reste en tier S et dis-le.

Choix du modèle par sous-tâche (paramètre \`model\` de \`subagent\`, format provider/id). Choisis le moins cher qui suffit ; monte d'un cran si la sous-tâche est difficile, redescends si elle est mécanique. Prix indicatifs $/Mtok entrée/sortie :
- Recon, résumé, docs, renommage, tests simples : openai-codex/gpt-5.6-luna (0.2/1.2) ou anthropic/claude-haiku-4-5 (1/5).
- Implémentation courante, 1-3 fichiers, règles claires : anthropic/claude-sonnet-5 (2/10).
- Difficile : refactor multi-modules, concurrence, algorithme, bug non localisé, API publique : anthropic/claude-opus-5-5 (4/20) ou openai-codex/gpt-5.6-sol (4/20).
- Revue : toujours une autre famille que le worker. Worker Claude → reviewer openai-codex/gpt-5.6-terra (2/12), ou gpt-5.6-sol si la zone est sensible (sécurité, données, CI). Worker GPT → reviewer anthropic/claude-sonnet-5.
- Ton propre modèle (chef) est le plus cher : ne le passe jamais à un worker.
Indique dans le rapport le modèle choisi par sous-tâche et pourquoi, en une ligne.

Règles fixes :
- Aucune affirmation sans preuve : montre la commande et sa sortie réelle. « Ça marche » sans sortie ne vaut rien.
- Respecte AGENTS.md et les conventions du projet. Un changement à la fois par write-set.
- Escalade à l'humain, sans agir : nouvelle dépendance, workflow CI, suppression de test, secret, diff > 200 lignes non mécanique, fichier hors write-set indispensable.
- Ni push, ni merge, ni commit sauf demande explicite. N'invente ni délégation ni approbation.
- Si la demande inclut un push ou une PR : après le push, pose une montre avec l'outil \`ci_watch\` (action start) et rends la main. Au réveil « checks red », lis le log fourni, délègue la correction à un worker, re-push, re-montre ; au deuxième échec identique, arrête et rapporte. Au réveil « checks green » ou « merged », rapporte et termine.

Termine par : ce qui a été fait, les preuves, ce qui reste ou bloque, et le tier/les agents réellement utilisés.

Demande :
`;

/** Demande libre à l'agent courant, ou exécution explicite des gates locales. */
export default function (pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let task: Promise<string> | undefined;
  const stop = async () => {
    active?.abort();
    await task?.catch(() => undefined);
  };
  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    if (!ctx?.hasUI) return;
    const workspace = await recommendedWorkspace(ctx.cwd);
    if (workspace) ctx.ui.notify(workspaceHint(workspace), "info");
  });
  pi.registerCommand("orchestrate", {
    description: "Orchestrer une demande : /orchestrate <demande>. Aussi : gates [quick|full|dry-run], status, cancel.",
    handler: async (args, ctx) => {
      const request = args.trim();
      const [action, mode = "full", ...extra] = request.split(/\s+/);
      if (!request) {
        ctx.ui.notify("Écris /orchestrate suivi de ta demande.", "info");
        return;
      }
      if (request === "cancel") {
        active?.abort();
        ctx.ui.notify(active ? "Arrêt des gates et de leurs processus en cours…" : "Aucun gate en cours.", "info");
        return;
      }
      if (request === "status") {
        ctx.ui.notify("Gates jj/prek disponibles : /orchestrate gates. Les revues précédentes ne valent pas approbation de cette version. Approbation Claude indisponible. Exécution autonome, push et merge non activés.", "info");
        return;
      }
      if (action !== "gates") {
        pi.sendUserMessage(ORCHESTRATE_PROMPT + request, { deliverAs: "followUp" });
        return;
      }
      if (!["quick", "full", "dry-run"].includes(mode) || extra.length) {
        ctx.ui.notify("Usage : /orchestrate gates [quick|full|dry-run] | status | cancel. Une politique de gates doit être configurée pour la racine jj.", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("Des gates sont déjà en cours dans cette session.", "warning");
        return;
      }
      active = new AbortController();
      ctx.ui.setStatus("orchestrate", `Gates ${mode} sur copie propre…`);
      try {
        const signals = ctx.signal ? [active.signal, ctx.signal] : [active.signal];
        task = runProcess(join(homedir(), ".local/bin/pi-prek"), [mode], {
          cwd: ctx.cwd, signal: AbortSignal.any(signals), timeoutMs: 2 * 60 * 60 * 1000,
          maxBytes: 8 * 1024 * 1024,
        });
        const output = await task;
        ctx.ui.notify(output.slice(-10000), "info");
      } catch (error) {
        ctx.ui.notify(`Gates BLOQUÉS : ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        active = undefined;
        task = undefined;
        ctx.ui.setStatus("orchestrate", undefined);
      }
    },
  });
}
