import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { runProcess } from "../../lib/process.ts";
import { onSessionReset, SessionTasks } from "../../lib/session-tasks.ts";
import { activationState, requiresRestart } from "../../lib/harness-activation.mjs";

const VERIFY_TIMEOUT_MS = 15 * 60_000;
/**
 * Self-improvement loop with a human in it: the agent patches the pi-agent-config source; after a
 * human agrees, this capability runs that source's verify gate on the host and, after a second
 * explicit human confirmation (ctx.ui.confirm only: never an automatic policy, never a remembered
 * grant), installs the exact tree verify saw into the agent directory. The installer keeps its own
 * backup; old releases remain available until /reload. Changed external dependencies require a restart.
 */
export function registerHarnessUpdate(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  let tasks = new SessionTasks(), busy = false;
  onSessionReset(pi, async () => { const previous = tasks; tasks = new SessionTasks(); await previous.close(); });
  pi.registerTool({
    name: "harness_update", label: "Install a verified harness source", executionMode: "sequential", exposure: "model-only",
    description: "After human confirmation, run the source repository's `npm run verify` on the host; after a second confirmation, install that exact tree as a separate release (backup kept). With package instead of source, install one pinned pi package after one confirmation. Never automatic or remembered. Activate harness releases with /reload; changed external dependencies need a restart. The result names the required action.",
    promptGuidelines: [
      "To improve the harness: patch the pi-agent-config source (normally the current workspace), run its tests with confined tools, then call harness_update with that source path and the reason. The human confirms the host verify and then the install; a red verify, a refusal or a source changed meanwhile installs nothing. Never edit the installed agent directory directly, and never present an install as active before the /reload or restart it names ran. Keeping the harness unchanged is a valid outcome when the evidence does not argue for a change. Prefer, in order: an on-demand skill, a script, a subagent, a tool_call guard; always-on prompt text last, paid for by cutting equal text (tests/prompt-budget pins the total).",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Absolute path of the pi-agent-config source repository" })),
      package: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "A pinned pi package to install into the runtime instead: npm:<name>@<exact version> or git:<host>/<owner>/<repo>@<commit sha>" })),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }, { additionalProperties: false }),
    async execute(id, input, signal, onUpdate, ctx) {
      if (busy) throw new Error("A harness update is already running");
      busy = true;
      try {
        return await tasks.run(async owned => {
          // A pi package runs with Pi's own rights: the human confirms, nothing is remembered, /reload activates it.
          const installPackage = async (name: string, reason: string) => {
            // Pi stores the source string as given, so only an exact version or commit keeps the dialog's "frozen version" true.
            if (!/^npm:(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(name) && !/^git:[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+@[0-9a-f]{40}$/.test(name)) throw new Error("package must be pinned: npm:<name>@<exact version> or git:<host>/<owner>/<repo>@<40-hex commit>; resolve the version first (ask_user if the user must choose)");
            const audit = new PermissionAudit(agentDir, ctx, { resource: "harness-update", operation: "install-package", toolCallId: id, payload: { package: name, reason } });
            try {
              if (!await ctx.ui.confirm("Installer ce paquet dans le runtime Pi ?", `Paquet : ${name}\nRaison : ${reason}\nIl s'exécutera avec les droits de Pi (scripts d'installation désactivés, version figée). Cible : ${agentDir}.`, { signal: owned })) {
                audit.finish("denied", "human"); throw new Error("Package install refused by the user; nothing installed");
              }
              validate();
              audit.finish("granted", "human", "once");
            } catch (error) { audit.finish("cancelled"); throw error; }
            const output = await execute("pi", ["install", name, "--no-approve"], { cwd: agentDir, signal: owned, timeoutMs: 10 * 60_000, maxBytes: 8 << 20, env: { PI_CODING_AGENT_DIR: agentDir, npm_config_save_exact: "true", npm_config_ignore_scripts: "true" } });
            pi.appendEntry("harness_update", { package: name, agentDir, at: new Date().toISOString() });
            ctx.ui.notify("Paquet installé : redémarre Pi avec pi -c pour charger ses dépendances.", "info");
            return { content: [{ type: "text" as const, text: `Installed ${name} into ${agentDir}. Restart Pi with pi -c to activate external dependencies.\n${output.trim().split("\n").slice(-6).join("\n")}` }], details: undefined };
          };
          const validate = () => {
            owned.throwIfAborted(); verify(ctx);
            if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || !pi.getActiveTools().includes("harness_update")) throw new Error("harness_update needs the interactive parent: a human confirms every install");
          };
          validate();
          if (!!input.source === !!input.package) throw new Error("Give exactly one of source (a pi-agent-config repository) or package (a pi package)");
          if (input.package) return installPackage(input.package, input.reason);
          const source = realpathSync(input.source!);
          let manifest: { name?: string } = {};
          try { manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")); } catch { /* reported below */ }
          if (manifest.name !== "pi-agent-config" || !existsSync(join(source, "scripts/install.mjs"))) throw new Error(`${source} is not a pi-agent-config source repository`);
          const git = async (args: string[], env?: Record<string, string>) => (await execute("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: source, signal: owned, timeoutMs: 60_000, maxBytes: 1 << 20, env })).trim();
          // Content identity of the working tree (tracked and untracked, ignored files excluded) through a
          // throwaway index: the approval and the install are bound to what verify saw, up to gitignored files.
          const treeDigest = async () => {
            const index = join(tmpdir(), `pi-harness-index-${process.pid}-${randomUUID()}`);
            try { await git(["add", "-A", "--", "."], { GIT_INDEX_FILE: index }); return await git(["write-tree"], { GIT_INDEX_FILE: index }); }
            finally { rmSync(index, { force: true }); }
          };
          // Human first: nothing runs in a model-chosen directory before this dialog (git included).
          const audit = new PermissionAudit(agentDir, ctx, { resource: "harness-update", operation: "install", toolCallId: id, payload: { source, reason: input.reason } });
          let tree = "";
          try {
            if (!await ctx.ui.confirm("Lancer npm run verify de cette source sur l'hôte ?", `Source : ${source}\nRaison : ${input.reason}\nverify exécute les scripts de ce dépôt hors sandbox. Rien n'est installé à cette étape ; l'installation sera confirmée séparément.`, { signal: owned })) {
              audit.finish("denied", "human"); throw new Error("Host verify refused by the user; nothing executed");
            }
            validate();
            const head = await git(["rev-parse", "--short", "HEAD"]), dirty = await git(["status", "--porcelain"]);
            tree = await treeDigest();
            const label = `${source} (${head}${dirty ? ", modifications non commitées" : ""}, arbre ${tree.slice(0, 12)})`;
            onUpdate?.({ content: [{ type: "text", text: `Running npm run verify in ${label}…` }], details: undefined });
            let log = "";
            try {
              await execute("npm", ["run", "verify"], { cwd: source, signal: owned, timeoutMs: VERIFY_TIMEOUT_MS, maxBytes: 8 << 20, onStdout: c => { log += c; }, onStderr: c => { log += c; } });
            } catch (error) {
              audit.finish("error", "human");
              throw new Error(`verify failed in ${source}; nothing installed.\n${log.slice(-3000)}\n${(error as Error).message}`);
            }
            const summary = log.split("\n").filter(line => /^ℹ (pass|fail|skipped)|verify: /.test(line)).join("; ");
            const unchanged = async () => { validate(); if (await treeDigest() !== tree) throw new Error("The source changed since verify started; nothing installed. Call harness_update again."); };
            await unchanged();
            // Human only: an automatic review policy never substitutes for this confirmation.
            if (!await ctx.ui.confirm("Installer cette source du harness dans le runtime Pi ?", `Source : ${label}\nVerify : ${summary || "ok"}\nRaison : ${input.reason}\nCible : ${agentDir} (sauvegarde automatique). La session en cours garde l'ancien runtime jusqu'à /reload.`, { signal: owned })) {
              audit.finish("denied", "human"); throw new Error("Install refused by the user; nothing installed");
            }
            await unchanged();
            audit.finish("granted", "human", "once");
          } catch (error) { audit.finish("cancelled"); throw error; }
          const before = activationState(agentDir);
          const output = await execute(process.execPath, [join(source, "scripts/install.mjs"), "--target", agentDir, "--hot-reload"], { cwd: source, signal: owned, timeoutMs: 10 * 60_000, maxBytes: 8 << 20 });
          const restart = requiresRestart(before, activationState(agentDir));
          pi.appendEntry("harness_update", { source, tree, agentDir, restart, at: new Date().toISOString() });
          ctx.ui.notify(restart ? "Des dépendances externes ou un ancien runtime ont changé : redémarre Pi avec pi -c." : "Harness installé : tape /reload pour l'activer, sans redémarrage.", "info");
          const activation = restart
            ? "Restart Pi to activate changed external dependencies or legacy modules (`pi -c` continues this session)"
            : "Run /reload to activate the release, including its .mjs dependencies (no restart)";
          return { content: [{ type: "text" as const, text: `Installed ${source} (tree ${tree.slice(0, 12)}) into ${agentDir}. ${activation}; this session runs the previous runtime until then.\n${output.trim().split("\n").slice(-6).join("\n")}` }], details: undefined };
        }, signal);
      } finally { busy = false; }
    },
  });
}
