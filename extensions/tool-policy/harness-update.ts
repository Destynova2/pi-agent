import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

const VERIFY_TIMEOUT_MS = 15 * 60_000;
// /reload re-imports TypeScript extensions, but Node keeps .mjs modules imported in-process (lib/runtime-paths,
// scripts/codex-network, …) cached for the life of the process. Any changed .mjs under these directories
// therefore needs a restart; spawned-only scripts are included, so this errs towards asking for one.
const CACHED_MODULE_DIRS = ["packages/pi-agent-config/lib", "packages/pi-agent-config/scripts", "scripts"];
export function cachedModulesDigest(agentDir: string): string {
  const hash = createHash("sha256");
  for (const dir of CACHED_MODULE_DIRS) {
    const path = join(agentDir, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).filter(entry => entry.endsWith(".mjs")).sort()) hash.update(`${dir}/${name}\0`).update(readFileSync(join(path, name))).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Self-improvement loop with a human in it: the agent patches the pi-agent-config source; after a
 * human agrees, this capability runs that source's verify gate on the host and, after a second
 * explicit human confirmation (ctx.ui.confirm only: never an automatic policy, never a remembered
 * grant), installs the exact tree verify saw into the agent directory. The installer keeps its own
 * backup; the running session keeps the old runtime until /reload, or a restart when cached .mjs modules changed.
 */
export function registerHarnessUpdate(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  let tasks = new SessionTasks(), busy = false;
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) {
    pi.on(event, async () => { const previous = tasks; tasks = new SessionTasks(); await previous.close(); });
  }
  pi.registerTool({
    name: "harness_update", label: "Install a verified harness source", executionMode: "sequential", exposure: "model-only",
    description: "After the human agrees, run the pi-agent-config source repository's `npm run verify` on the host; after a second human confirmation, install the verified tree into the agent directory with its own installer (backup kept). With package instead of source, install one pi package (npm:… or git:…) after one human confirmation. Never automatic, never remembered. The running session keeps the old runtime until /reload (or a restart when installed .mjs modules changed; the result says which).",
    promptGuidelines: [
      "To improve the harness: patch the pi-agent-config source (normally the current workspace), run its tests with confined tools, then call harness_update with that source path and the reason. The human confirms the host verify and then the install; a red verify, a refusal or a source changed meanwhile installs nothing. Never edit the installed agent directory directly, and never present an install as active before the /reload or restart it names ran. Keeping the harness unchanged is a valid outcome when the evidence does not argue for a change. Prefer, in order: an on-demand skill, a script, a subagent, a tool_call guard; always-on prompt text last, paid for by cutting equal text (tests/prompt-budget pins the total).",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Absolute path of the pi-agent-config source repository" })),
      package: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "A pi package to install into the runtime instead, e.g. npm:pi-web-access or git:github.com/org/repo@sha" })),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }, { additionalProperties: false }),
    async execute(id, input, signal, onUpdate, ctx) {
      if (busy) throw new Error("A harness update is already running");
      busy = true;
      try {
        return await tasks.run(async owned => {
          // A pi package runs with Pi's own rights: the human confirms, nothing is remembered, /reload activates it.
          const installPackage = async (name: string, reason: string) => {
            if (!/^(npm|git):[A-Za-z0-9@._\/-]+$/.test(name)) throw new Error("package must look like npm:<name>[@version] or git:<host>/<owner>/<repo>[@ref]");
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
            ctx.ui.notify("Paquet installé : tape /reload pour l'activer.", "info");
            return { content: [{ type: "text" as const, text: `Installed ${name} into ${agentDir}. Run /reload to activate it; this session runs without it until then.\n${output.trim().split("\n").slice(-6).join("\n")}` }], details: undefined };
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
          const modulesBefore = cachedModulesDigest(agentDir);
          const output = await execute(process.execPath, [join(source, "scripts/install.mjs"), "--target", agentDir], { cwd: source, signal: owned, timeoutMs: 10 * 60_000, maxBytes: 8 << 20 });
          const restart = cachedModulesDigest(agentDir) !== modulesBefore;
          pi.appendEntry("harness_update", { source, tree, agentDir, restart, at: new Date().toISOString() });
          ctx.ui.notify(restart ? "Harness installé : des modules .mjs ont changé, redémarre Pi (pi -c reprend cette session)." : "Harness installé : tape /reload pour l'activer, sans redémarrage.", "info");
          const activation = restart
            ? "Restart Pi to activate it (`pi -c` continues this session): installed .mjs modules changed and Node keeps them cached past /reload"
            : "Run /reload to activate it (TypeScript extensions, settings and launchers reload in place, no restart)";
          return { content: [{ type: "text" as const, text: `Installed ${source} (tree ${tree.slice(0, 12)}) into ${agentDir}. ${activation}; this session runs the previous runtime until then.\n${output.trim().split("\n").slice(-6).join("\n")}` }], details: undefined };
        }, signal);
      } finally { busy = false; }
    },
  });
}
