import { hasAutomaticReview } from "../../lib/approval-review.ts";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { approvalDialog } from "../../lib/approval-dialog.ts";
import { archiveWorktrees, validateWorktreeRemoval, worktreeIdentity, worktreeRequest, type WorktreeSnapshot } from "../../lib/git-worktree.ts";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerGitWorktree(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const command = [process.execPath, join(runtimeRoot, "scripts/git-worktree.mjs")].map(quote).join(" ");
  let tasks = new SessionTasks(), tail: Promise<unknown> = Promise.resolve();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, reset);
  pi.registerCommand("git-worktree", {
    description: "/git-worktree reset: cancel pending worktree cleanup and clear refusals",
    async handler(args, ctx) {
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Worktree cleanup requires the interactive parent");
      if (args.trim() !== "reset") return ctx.ui.notify("usage: /git-worktree reset", "info");
      await reset(); ctx.ui.notify("Pending worktree cleanup canceled. Existing recovery archives remain.", "info");
    },
  });
  pi.registerTool({
    name: "git_worktree_cleanup", label: "Review and retire Git worktrees", executionMode: "sequential", exposure: "model-only",
    description: "Inspect linked worktrees without approval, then request exact one-time approval to remove named worktrees or prune named missing registrations. Removal archives ALL files (dirty, untracked and ignored included) and Git metadata in private storage, keeps every local branch, and pins all HEAD commits, including detached ones. Never deletes a branch, pushes, purges archives or grants Bash access. Git inspection stays offline inside Codex; the parent moves only revalidated paths. Active/current, locked, nested and concurrently changed worktrees are refused with a next action. Local remote-tracking refs are evidence only, not a fresh remote check.",
    promptGuidelines: ["When requested cleanup cannot run in Bash, call inspect, review the inventory and propose exact paths through remove or prune. Do not send the user a manual shell command when this capability handles the request. Removing a worktree keeps its branch and local commits: no push-or-discard choice is needed just to retire a directory. Explain that dirty/ignored files are retained in a private archive. Never interpret cleanup permission as permission to publish or discard commits. Prune only the explicitly reviewed missing paths. After a partial failure, inspect the receipt and current state before a new request. /git-worktree reset cancels pending operations and clears refusals."],
    parameters: Type.Object({ operation: Type.Union([Type.Literal("inspect"), Type.Literal("remove"), Type.Literal("prune")]), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })), reason: Type.String() }, { additionalProperties: false }),
    async execute(id, input, signal, _update, ctx) {
      const request = worktreeRequest(input), cwd = realpathSync(ctx.cwd);
      return tasks.run(async owned => {
        const run = async () => {
          const validate = () => { owned.throwIfAborted(); verify(ctx); if ((!ctx.hasUI && !hasAutomaticReview(agentDir, ctx)) || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("git_worktree_cleanup")) throw new Error("Worktree cleanup requires the active interactive parent or a configured automatic parent policy in the same workspace"); };
          validate();
          const binary = serverIdentity("/usr/bin/git", [], cwd);
          const inspect = async (): Promise<WorktreeSnapshot> => {
            const raw = await execute(launcher, ["--offline", "-c", command], { cwd, signal: owned, input: JSON.stringify(request), timeoutMs: 300000, maxBytes: 4 * 1024 * 1024 });
            const output = JSON.parse(raw);
            if (output.error) throw new Error(output.error);
            validate();
            const snapshot: WorktreeSnapshot = output.result;
            return { ...snapshot, identity: worktreeIdentity(snapshot.root, snapshot.commonDir) };
          };
          const snapshot = await inspect();
          if (request.operation === "inspect") return { content: [{ type: "text" as const, text: JSON.stringify(snapshot) }], details: undefined };
          const expires = Date.now() + 15 * 60 * 1000;
          const revalidate = () => {
            validate();
            if (Date.now() > expires || fingerprint(serverIdentity("/usr/bin/git", [], cwd)) !== fingerprint(binary)) throw new Error("Worktree approval expired or Git executable changed; inspect again");
            validateWorktreeRemoval(snapshot, request, cwd);
            for (const path of [snapshot.commonDir, ...snapshot.entries.filter(entry => entry.present).map(entry => entry.path)]) commandWritableRoots([path], cwd, agentDir, [getPackageDir()]);
          };
          revalidate();
          const scoped: ExtensionContext = { ...ctx, cwd: snapshot.root, ui: { ...ctx.ui, select: (title, choices, options) => approvalDialog(ctx, title, choices, options) } };
          const ticket = await approvals.authorize(scoped, {
            resource: "git-worktree", auditOperation: request.operation, toolCallId: id, identity: fingerprint([snapshot.identity, binary]), operation: fingerprint([request, snapshot]), remember: false, interactiveOnly: true, automaticWithoutUI: true,
            title: "Valider le retrait de ces worktrees ?",
            detail: `Cette opération uniquement. Branches et commits locaux conservés, aucun push. Tous les fichiers et métadonnées seront archivés dans ${join(agentDir, "worktree-archives")}. Aucun effacement définitif.\n${request.reason}\n${JSON.stringify(snapshot.entries.map(({ path, head, branch, present, locked, dirty, knownRemote, files }) => ({ path, head, branch, present, locked, dirty, knownRemote, files })), null, 2)}`,
            revalidate,
          }, owned, ctx);
          ticket();
          if (fingerprint(await inspect()) !== fingerprint(snapshot)) throw new Error("Worktree state changed during approval; inspect again");
          ticket();
          const result = archiveWorktrees(snapshot, request, cwd, agentDir);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
        };
        const result = tail.then(run, run); tail = result.catch(() => undefined); return result;
      }, signal);
    },
  });
}
