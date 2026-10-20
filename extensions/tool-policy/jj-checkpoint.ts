import { hasAutomaticReview } from "../../lib/approval-review.ts";
import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { checkpointReason, checkpointRepository, checkpointRoot, checkpointIdentity, createCheckpointTransaction, closeCheckpointTransaction, publishCheckpoint, type CheckpointInspection, type CheckpointResult } from "../../lib/jj-checkpoint.ts";
import { onSessionReset, SessionTasks } from "../../lib/session-tasks.ts";
import { runProcess } from "../../lib/process.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerJjCheckpoint(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const command = [process.execPath, join(runtimeRoot, "scripts/jj-checkpoint.mjs")].map(quote).join(" ");
  let tasks = new SessionTasks(), tail: Promise<unknown> = Promise.resolve();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  onSessionReset(pi, reset);
  pi.registerCommand("jj-checkpoint", {
    description: "/jj-checkpoint permissions [repository]: revoke checkpoint consent for the current or named repository",
    async handler(args, ctx) {
      const match = /^permissions(?:\s+(.+))?$/.exec(args.trim());
      if (!match) return ctx.ui.notify("usage: /jj-checkpoint permissions [canonical repository path]", "info");
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Checkpoints require the interactive parent");
      const cwd = realpathSync(ctx.cwd), root = checkpointRoot(checkpointRepository(cwd, match[1]));
      await reset(); verify(ctx);
      if (realpathSync(ctx.cwd) !== cwd) throw new Error("Workspace changed during revocation");
      if (checkpointRoot(checkpointRepository(cwd, match[1])) !== root) throw new Error("Checkpoint repository changed during revocation");
      approvals.revoke(root, "jj-checkpoint");
      ctx.ui.notify("Checkpoint consent revoked. Existing checkpoints remain.", "info");
    },
  });
  pi.registerTool({
    name: "jj_checkpoint", label: "Save a local recovery point", executionMode: "sequential", exposure: "model-only",
    description: "Snapshot working files before authorized edits, initializing jj/Git if missing; return full operation/commit IDs and a private Git ref retaining contents. Preserve Git index, branches, config and files. Main colocated repositories may have linked worktrees, preserved but not backed up. Existing Git objects stay read-only. Consent is separate from Git commit/push, reusable per project. No restore, commit publication, network, arbitrary commands or jj installation. Ignored files and external state are excluded; unsupported files/layouts fail. Not a full-system backup.",
    promptGuidelines: ["Select each repository explicitly; the session cwd and Bash access remain unchanged. Checkpoint again before a separately requested risky phase. Do not run for read-only audits or from children."],
    parameters: Type.Object({ reason: Type.String(), repository: Type.Optional(Type.String({ description: "Exact canonical absolute root of an existing main Git repository. Select a child or separate repository without changing the session cwd. Omit to use the current project, initializing Git/jj there if missing." })) }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      const reason = checkpointReason(input), cwd = realpathSync(ctx.cwd), workdir = checkpointRepository(cwd, input.repository);
      return tasks.run(async owned => {
        const run = async () => {
          const validate = () => {
            owned.throwIfAborted(); verify(ctx);
            if ((!ctx.hasUI && !hasAutomaticReview(agentDir, ctx)) || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("jj_checkpoint")) throw new Error("Checkpoints require the active interactive parent or a configured automatic parent policy in the same workspace");
            if (checkpointRepository(cwd, input.repository) !== workdir) throw new Error("Checkpoint repository changed");
          };
          validate();
          const binary = serverIdentity("jj", [], cwd), gitBinary = serverIdentity("/usr/bin/git", [], cwd);
          const query = async (action: "inspect" | "snapshot", sandboxCwd: string, roots?: string[], protectedMetadata: string[] = []) => {
            const args = roots ? ["--write-roots", JSON.stringify(roots), "--read-roots", JSON.stringify(protectedMetadata), "--offline", "-c", command] : ["--offline", "-c", command];
            const raw = await execute(launcher, args, { cwd: sandboxCwd, signal: owned, input: JSON.stringify({ action, binary: binary.command, ...(action === "inspect" && input.repository !== undefined ? { repository: input.repository } : {}) }), timeoutMs: 300000, maxBytes: 4 * 1024 * 1024 });
            const output = JSON.parse(raw);
            if (output.error) throw new Error(output.error);
            validate(); return output.result;
          };
          const inspect = async (): Promise<CheckpointInspection> => {
            const root = checkpointRoot(workdir), identity = checkpointIdentity(root);
            // Inspection keeps the session sandbox; only the fixed worker reads
            // the selected repository. Snapshot writes stay on a disposable copy.
            const inspected: CheckpointInspection = await query("inspect", cwd);
            if (inspected.root !== root || checkpointRoot(workdir) !== root || checkpointIdentity(root) !== identity) throw new Error("Checkpoint repository changed during inspection");
            // Codex can replace an empty .git with a protected mount. Keep the
            // parent's identity, checked on both sides of every confined read.
            return { ...inspected, identity };
          };
          const info = await inspect();
          if (info.root !== checkpointRoot(workdir)) throw new Error("Checkpoint root differs from the selected project");
          const writePaths = [join(info.root, ".git"), join(info.root, ".jj")];
          commandWritableRoots(writePaths, cwd, agentDir, [getPackageDir()]);
          const expires = Date.now() + 300000;
          const revalidate = () => {
            validate();
            if (Date.now() > expires || fingerprint(serverIdentity("jj", [], cwd)) !== fingerprint(binary) || fingerprint(serverIdentity("/usr/bin/git", [], cwd)) !== fingerprint(gitBinary)) throw new Error("Checkpoint consent expired or executable changed");
            commandWritableRoots(writePaths, cwd, agentDir, [getPackageDir()]);
          };
          const scoped: ExtensionContext = { ...ctx, cwd: info.root, ui: { ...ctx.ui, select: async (title, choices, options) => {
            if (wrapTextWithAnsi(title, Math.max(20, (process.stdout.columns ?? 80) - 4)).length > Math.max(1, (process.stdout.rows ?? 24) - choices.length - 6)) throw new Error("Checkpoint approval does not fit the terminal; shorten the reason or enlarge the window");
            return ctx.ui.select(title, choices, options);
          } } };
          const ticket = await approvals.authorize(scoped, {
            resource: "jj-checkpoint", toolCallId: _id, auditOperation: "snapshot", identity: fingerprint([info.identity, binary, gitBinary]), operation: "local-checkpoint-v1", remember: info.initialized, interactiveOnly: true, automaticWithoutUI: true,
            title: "Autoriser les points de restauration jj ?",
            detail: `${info.root}\n${reason}\n${info.initialized ? "Consentement session/projet : futurs instantanés locaux." : "Initialise jj/Git et prend un premier instantané, cette fois uniquement."}\nFichiers suivis et nouveaux non ignorés. Aucun push ni restauration. Index et fichiers actuels conservés. Fichiers ignorés et état externe exclus.`,
            revalidate,
          }, owned, ctx);
          ticket();
          const current = await inspect();
          if (fingerprint(current) !== fingerprint(info)) throw new Error("Checkpoint project changed during approval");
          const tx = createCheckpointTransaction(info);
          try {
            ticket();
            // .jj is ordinary storage within the disposable cwd. Do not mount
            // its absent root: jj must create it itself on first initialization.
            const roots = commandWritableRoots([join(tx.stage, ".git")], tx.stage, agentDir, [getPackageDir()]);
            const protectedMetadata = tx.gitBefore.size ? [join(tx.stage, ".git/config"), join(tx.stage, ".git/hooks"), ...(tx.pool ? [tx.pool.path, join(tx.stage, ".git/objects/info")] : [])] : [];
            const result: CheckpointResult = await query("snapshot", tx.stage, roots, protectedMetadata);
            const latest = await inspect();
            if (fingerprint(latest) !== fingerprint(info)) throw new Error("Checkpoint project changed while snapshotting");
            ticket();
            const published = publishCheckpoint(tx, result);
            return { content: [{ type: "text" as const, text: JSON.stringify(published) }], details: undefined };
          } finally { closeCheckpointTransaction(tx); }
        };
        const result = tail.then(run, run); tail = result.catch(() => undefined); return result;
      }, signal);
    },
  });
}
