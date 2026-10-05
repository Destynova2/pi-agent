import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { checkpointReason, checkpointRoot, createCheckpointTransaction, closeCheckpointTransaction, publishCheckpoint, type CheckpointInspection, type CheckpointResult } from "../../lib/jj-checkpoint.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { runProcess } from "../../lib/process.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerJjCheckpoint(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(agentDir, "scripts/codex-shell.mjs");
  const command = [process.execPath, join(agentDir, "scripts/jj-checkpoint.mjs")].map(quote).join(" ");
  let tasks = new SessionTasks(), tail: Promise<unknown> = Promise.resolve();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, reset);
  pi.registerCommand("jj-checkpoint", {
    description: "/jj-checkpoint permissions: revoke checkpoint consent for this project",
    async handler(args, ctx) {
      if (args.trim() !== "permissions") return ctx.ui.notify("usage: /jj-checkpoint permissions", "info");
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Checkpoints require the interactive parent");
      const cwd = realpathSync(ctx.cwd), root = checkpointRoot(cwd);
      await reset(); verify(ctx);
      if (realpathSync(ctx.cwd) !== cwd) throw new Error("Workspace changed during revocation");
      approvals.revoke(root, "jj-checkpoint");
      ctx.ui.notify("Checkpoint consent revoked. Existing checkpoints remain.", "info");
    },
  });
  pi.registerTool({
    name: "jj_checkpoint", label: "Save a local recovery point", executionMode: "sequential", exposure: "model-only",
    description: "Before authorized file edits, initialize jj/Git only if missing, then save the current working files and return full operation/commit IDs. Existing Git index, branches, configuration and working files are preserved. Ordinary colocated repositories only. Local checkpoint consent is separate from Git commit/push consent and may be remembered per project. No restore, commit publication, network operation or arbitrary command. Ignored files and external state are not backed up; unsupported files/layouts fail explicitly.",
    promptGuidelines: ["Use once before each new authorized modification task, and before a separately requested risky phase. Reuse the checkpoint during continuation; do not reinitialize an existing jj workspace. Record both returned IDs and gitRef with the task. The private Git ref retains local file contents without creating a branch or publishing them. Do not run for read-only audits or from children. Missing jj needs installation approval; this tool never installs it. Report a blocked checkpoint without claiming recoverability. A checkpoint is not a full-system backup. Restore requires an explicit separate user request."],
    parameters: Type.Object({ reason: Type.String() }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      const reason = checkpointReason(input), cwd = realpathSync(ctx.cwd);
      return tasks.run(async owned => {
        const run = async () => {
          const validate = () => {
            owned.throwIfAborted(); verify(ctx);
            if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("jj_checkpoint")) throw new Error("Checkpoints require the active interactive parent in the same workspace");
          };
          validate();
          const binary = serverIdentity("jj", [], cwd), gitBinary = serverIdentity("/usr/bin/git", [], cwd);
          const query = async (action: "inspect" | "snapshot", workdir: string, roots?: string[], protectedMetadata: string[] = []) => {
            const args = roots ? ["--write-roots", JSON.stringify(roots), "--read-roots", JSON.stringify(protectedMetadata), "--offline", "-c", command] : ["--offline", "-c", command];
            const raw = await execute(launcher, args, { cwd: workdir, signal: owned, input: JSON.stringify({ action, binary: binary.command }), timeoutMs: 300000, maxBytes: 4 * 1024 * 1024 });
            const output = JSON.parse(raw);
            if (output.error) throw new Error(output.error);
            validate(); return output.result;
          };
          const info: CheckpointInspection = await query("inspect", cwd);
          if (info.root !== checkpointRoot(cwd)) throw new Error("Checkpoint root differs from the current project");
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
            resource: "jj-checkpoint", identity: fingerprint([info.identity, binary, gitBinary]), operation: "local-checkpoint-v1", remember: info.initialized, interactiveOnly: true,
            title: "Autoriser les points de restauration jj ?",
            detail: `${info.root}\n${reason}\n${info.initialized ? "Consentement session/projet : futurs instantanés locaux." : "Initialise jj/Git et prend un premier instantané, cette fois uniquement."}\nFichiers suivis et nouveaux non ignorés. Aucun push ni restauration. Index et fichiers actuels conservés. Fichiers ignorés et état externe exclus.`,
            revalidate,
          }, owned);
          ticket();
          const current: CheckpointInspection = await query("inspect", cwd);
          if (fingerprint(current) !== fingerprint(info)) throw new Error("Checkpoint project changed during approval");
          const tx = createCheckpointTransaction(info);
          try {
            ticket();
            // .jj is ordinary storage within the disposable cwd. Do not mount
            // its absent root: jj must create it itself on first initialization.
            const roots = commandWritableRoots([join(tx.stage, ".git")], tx.stage, agentDir, [getPackageDir()]);
            const protectedMetadata = tx.gitBefore.size ? [join(tx.stage, ".git/config"), join(tx.stage, ".git/hooks")] : [];
            const result: CheckpointResult = await query("snapshot", tx.stage, roots, protectedMetadata);
            const latest: CheckpointInspection = await query("inspect", cwd);
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
