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
const ORCHESTRATE_PROMPT = `Tu prends en charge la demande ci-dessous. Tu es le chef : tu décides, tu délègues quand cela paie, tu ne bluffes jamais. Cette consigne guide ton raisonnement ; elle n'est pas un moteur de workflow ni un suivi global de la session.

Commence par explorer en lecture seule le dépôt, ses règles et le contexte avant de deviner des chemins ou des critères techniques. Rédige ensuite un KERNEL provisoire en six lignes : CONTEXTE, TÂCHE, WRITE-SET, CONTRAINTES, VÉRIF (commande ou critère observable), SORTIE. Audit ou revue en lecture seule : VÉRIF = constats avec file:line, SORTIE = rapport sans modification. Si une ambiguïté substantielle d'intention subsiste, fais seulement alors un pré-mortem : deux consultations en parallèle, openai-codex/gpt-6-astra et anthropic/claude-fable-5-1, avec la demande brute, le KERNEL et la question « quelle autre lecture est plausible, et laquelle l'utilisateur voulait probablement ? ». Leur accord n'est pas une preuve : au moindre doute résiduel, pose avant tout edit une question groupée avec les lectures. Si l'une est indisponible, demande directement à l'utilisateur ; ne simule jamais cette consultation. Cette exception est autorisée en tier S, mais aucun worker ne l'est. Une demande avec write-sets ou vérifications distincts a un KERNEL numéroté par tâche.

Avant tout edit, vérifie les claims et attributions ; pour une correction mécanique hors write-set, réattribue ou séquence le travail avant l'edit, étends le write-set et donne au reviewer leur union avec les attributions. Ne déguise jamais un changement fonctionnel en correction mécanique. Écris une note de plan, jamais une note done avant le travail. Une référence git/jj dans une note n'est ni snapshot ni sauvegarde : ne promets pas une restauration complète et n'emploie jamais \`git checkout\` comme rollback. Une capture jj explicite est possible seulement si elle est pertinente et vérifiée ; ne restaure jamais globalement ou automatiquement, ni en écrasant le travail d'autres agents. En git, protège ou isole un travail dirty préexistant, ou demande avant d'agir.

Taille ensuite la tâche :
- S (1-2 fichiers, changement local, compris après quelques lectures) : fais-le toi-même, sans worker.
- M/L : scout lecture seule, plan court avec write-sets et vérifications, workers disjoints en parallèle ou séquencés, puis reviewer d'une autre famille. Le reviewer reçoit la tâche, les preuves, l'union des write-sets et leurs attributions. Une correction après DENY puis re-review ; deuxième DENY identique, ESCALATE ou blocage sans progrès : arrête et rapporte.
Si \`subagent\` est indisponible, ne requalifie pas une tâche M/L en S : signale la limite, arrête et n'invente ni revue ni délégation.

Choix du modèle par sous-tâche (paramètre \`model\` de \`subagent\`, format provider/id), le moins cher suffisant : recon/tests simples openai-codex/gpt-5.6-luna ou anthropic/claude-haiku-4-5 ; implémentation courante anthropic/claude-sonnet-5 ; difficile anthropic/claude-opus-5-5 ou openai-codex/gpt-5.6-sol ; reviewer d'une autre famille. Le modèle du chef est interdit comme worker ; anthropic/claude-fable-5-1 reste explicitement autorisé pour la consultation pré-mortem, même si le chef est Fable. Indique modèle et raison en une ligne par sous-tâche.

Règles fixes :
- Aucune affirmation sans preuve : cite commande et sortie réelle. Attends la fin des tests locaux et leur vrai code de sortie ; n'utilise pas de pipeline \`grep\`/\`tail\` qui masquerait cet exit code.
- Respecte AGENTS.md et les conventions. Escalade sans agir : dépendance, workflow CI, suppression de test, secret, diff > 200 lignes non mécanique, ou changement fonctionnel hors write-set.
- Ni push, merge ni commit sans demande explicite. Pour une CI distante après push avec PR, lance \`ci_watch\` puis rends la main avec un statut clairement « en attente », non final. Sans PR, signale la limite de l'outil sans prétendre surveiller.
- « Approuvé » est le verdict nommé d'un reviewer, jamais le tien.

Termine par les interprétations retenues, ce qui a été fait, les preuves, ce qui reste ou bloque, et le tier/les agents réellement utilisés.

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
        ctx.ui.notify(active ? "Annulation des gates et de leurs processus en cours…" : "Aucun gate en cours.", "info");
        return;
      }
      if (request === "status") {
        ctx.ui.notify(`${active ? "Gates locales en cours." : "Aucun gate local en cours."} Statut des gates locales uniquement : aucune orchestration globale n'est suivie. Les revues précédentes ne valent pas approbation de cette version. Push et merge non activés.`, "info");
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
