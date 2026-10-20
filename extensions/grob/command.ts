import { spawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { grobFetch, grobUrl } from "../../lib/grob.ts";

const PROVIDER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ACTIONS = ["connect", "reconnect", "status", "start"] as const;
type Action = typeof ACTIONS[number];
const CHOICES = ["Connecter un fournisseur", "Reconnecter un fournisseur", "État du proxy", "Démarrer le proxy"];
const USAGE = "/grob [connect|reconnect [fournisseur]|status|start]";
const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
};

/** Discover names only; never retrieve Grob's configuration or credentials. */
export async function grobProviders(baseUrl: string): Promise<string[]> {
    const base = grobUrl(baseUrl);
    const response = await grobFetch(base)(`${base}/rpc`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "pi-providers", method: "grob/provider/list" }),
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Catalogue Grob indisponible");
    const body = await response.json() as { result?: { name?: unknown }[]; error?: unknown };
    if (body.error || !Array.isArray(body.result) || body.result.length > 100) throw new Error("Catalogue Grob invalide");
    return [...new Set(body.result.map(p => p?.name).filter((name): name is string => typeof name === "string" && PROVIDER.test(name)))].sort();
}

/** Fixed CLI and operator config, outside the project; no shell evaluation. */
export function grobInvocation(cwd: string, env: NodeJS.ProcessEnv = process.env) {
    const project = realpathSync(cwd), home = realpathSync(homedir());
    let binary: string | undefined;
    for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
        const candidate = join(directory, "grob");
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile()) { binary = realpathSync(candidate); break; }
        } catch { /* Try the next installed executable. */ }
    }
    if (!binary) throw new Error("Grob est introuvable dans le PATH absolu de Pi");
    if (inside(project, binary)) throw new Error("Le binaire Grob doit être installé hors du projet");
    const selected = env.GROB_CONFIG ?? join(home, ".grob/config.toml");
    if (!isAbsolute(selected)) throw new Error("GROB_CONFIG doit désigner un fichier local absolu hors du projet");
    const config = realpathSync(selected);
    if (!statSync(config).isFile() || inside(project, config)) throw new Error("La configuration Grob doit être un fichier hors du projet");
    if (env.GROB_HOME) {
        if (!isAbsolute(env.GROB_HOME)) throw new Error("GROB_HOME doit désigner un dossier absolu hors du projet");
        const storage = realpathSync(env.GROB_HOME);
        if (!statSync(storage).isDirectory() || inside(project, storage)) throw new Error("GROB_HOME doit désigner un dossier absolu hors du projet");
    }
    return { binary, config, cwd: home };
}

function launchGrob(binary: string, args: string[], options: SpawnOptions): Promise<{ status: number | null; signal: string | null; error?: Error }> {
    return new Promise(resolve => {
        const child = spawn(binary, args, options);
        child.once("error", error => resolve({ status: null, signal: null, error }));
        child.once("close", (status, signal) => resolve({ status, signal }));
    });
}

/** The SDK's terminal handoff, restricted to these fixed Grob actions. */
export async function grobTerminal(ctx: ExtensionCommandContext, action: Exclude<Action, "status">, provider: string | undefined, execute = launchGrob) {
    if (!ctx.hasUI || ctx.mode !== "tui" || process.env.PI_SUBAGENT_CHILD || !ctx.isIdle()) throw new Error("Grob nécessite un terminal Pi interactif et disponible");
    if (!["connect", "reconnect", "start"].includes(action) || (provider !== undefined && !PROVIDER.test(provider)) ||
        (action === "reconnect" && !provider) || (action === "start" && provider)) throw new Error("Commande Grob invalide");
    const invocation = grobInvocation(ctx.cwd);
    const args = ["--config", invocation.config, ...(action === "start" ? ["start", "-d"] : ["connect", ...(provider ? [provider] : []), ...(action === "reconnect" ? ["--force-reauth"] : [])])];
    return ctx.ui.custom<{ status: number | null; signal: string | null; failed: boolean }>(async (tui, _theme, _keys, done) => {
        let outcome = { status: null as number | null, signal: null as string | null, failed: true };
        // Ctrl+C reaches the whole foreground process group. Keep the event
        // loop running to consume Pi's signal while Grob handles its own.
        const ignoreSigint = () => {};
        process.on("SIGINT", ignoreSigint);
        try {
            tui.stop();
            // OAuth prompts and codes belong to the terminal, not the model,
            // session entries, audit records or subprocess capture buffers.
            process.stdout.write("\x1b[2J\x1b[H");
            const result = await execute(invocation.binary, args, {
                cwd: invocation.cwd, env: process.env, stdio: "inherit", shell: false, timeout: 600_000,
            });
            outcome = { status: result.status, signal: result.signal, failed: Boolean(result.error) };
        } catch {
            // No native error text or OAuth output enters the conversation.
        } finally {
            await new Promise<void>(resolve => setImmediate(resolve));
            process.off("SIGINT", ignoreSigint);
            tui.start();
            tui.requestRender(true);
            done(outcome);
        }
        return { render: () => [], invalidate: () => {} };
    });
}

export function registerGrobCommand(pi: ExtensionAPI, baseUrl: string, health: (url: string) => Promise<boolean>,
    dependencies = { providers: grobProviders, terminal: grobTerminal }) {
    let busy = false;
    let lifecycle = new AbortController();
    const reset = () => { lifecycle.abort(); lifecycle = new AbortController(); };
    pi.on("session_start", reset);
    pi.on("session_before_switch", reset);
    pi.on("session_before_fork", reset);
    pi.on("session_shutdown", reset);
    pi.registerCommand("grob", {
        description: "Grob : connexion/reconnexion des fournisseurs, état et démarrage du proxy",
        getArgumentCompletions: prefix => ACTIONS.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action })),
        async handler(raw, ctx) {
            if (!ctx.hasUI || ctx.mode !== "tui" || process.env.PI_SUBAGENT_CHILD) {
                ctx.ui.notify("/grob nécessite le terminal interactif de Pi", "warning"); return;
            }
            if (busy || !ctx.isIdle()) { ctx.ui.notify("Attends la fin de l’opération en cours avant /grob", "warning"); return; }
            busy = true;
            const signal = lifecycle.signal;
            try {
                const parts = raw.trim().split(/\s+/).filter(Boolean);
                let action = parts[0] as Action | undefined;
                let provider: string | undefined = parts[1];
                if (parts.length > 2 || (action && !ACTIONS.includes(action)) || (provider && !PROVIDER.test(provider)) ||
                    ((action === "status" || action === "start") && provider)) throw new Error(USAGE);
                if (!action) {
                    const choice = await ctx.ui.select("Grob", CHOICES, { signal });
                    if (choice === undefined) return;
                    action = ACTIONS[CHOICES.indexOf(choice)];
                    if (!action) return;
                }
                if (action === "status") {
                    const healthy = await health(baseUrl);
                    const names = healthy ? await dependencies.providers(baseUrl).catch(() => []) : [];
                    if (signal.aborted) return;
                    ctx.ui.notify(healthy
                        ? `Proxy Grob accessible${names.length ? ` · ${names.join(", ")}` : ""}. Ce contrôle ne valide pas les connexions OAuth.`
                        : "Proxy Grob indisponible ou GROB_URL invalide. Utilise /grob start.", healthy ? "info" : "warning");
                    return;
                }
                if (action !== "start" && !provider) {
                    const names = await dependencies.providers(baseUrl).catch(() => []);
                    if (signal.aborted) return;
                    provider = names.length
                        ? await ctx.ui.select(action === "reconnect" ? "Fournisseur à reconnecter" : "Fournisseur à connecter", names, { signal })
                        : (await ctx.ui.input("Nom du fournisseur configuré dans Grob", "anthropic ou chatgpt-codex", { signal }))?.trim();
                    if (!provider) return;
                    if (!PROVIDER.test(provider)) throw new Error("Nom de fournisseur Grob invalide");
                }
                // A slash command is the user's explicit action. It is not a
                // model tool, a Bash exception, or a delegated credential flow.
                if (signal.aborted) return;
                if (!ctx.isIdle()) { ctx.ui.notify("Attends la fin de l’opération en cours avant /grob", "warning"); return; }
                const result = await dependencies.terminal(ctx, action, provider);
                if (signal.aborted) return;
                if (result.failed || result.status !== 0) ctx.ui.notify("Assistant Grob interrompu ou en échec ; aucune reconnexion automatique.", "warning");
                else if (action === "start") ctx.ui.notify(await health(baseUrl) ? "Proxy Grob accessible." : "Grob a terminé, mais le proxy ne répond pas sur GROB_URL.", "info");
                else ctx.ui.notify("Assistant Grob terminé. Pi reprend ; le code de sortie seul ne garantit pas la connexion du fournisseur.", "info");
            } catch (error) {
                if (signal.aborted) return;
                // Only our fixed diagnostics are displayed; native process output
                // stays in its terminal and is never copied into the transcript.
                ctx.ui.notify(error instanceof Error && (error.message === USAGE || /^(Grob |GROB_|Le binaire Grob |La configuration Grob |Nom de fournisseur Grob )/.test(error.message))
                    ? error.message : "Impossible de lancer Grob. Vérifie son installation et sa configuration locale.", "error");
            } finally { busy = false; }
        },
    });
}
