import { hasAutomaticReview } from "../../lib/approval-review.ts";
import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalDialog } from "../../lib/approval-dialog.ts";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { closeGitTransaction, createGitTransaction, publishGitTransaction } from "../../lib/git-transaction.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";
import { normalizeHost, readNetworkPolicy } from "../../scripts/codex-network.mjs";
import { gitRepositoryRoot, gitWritePaths, validateGitRequest, type GitSnapshot } from "./git-access-core.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerGitAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const command = `${quote(process.execPath)} ${quote(join(runtimeRoot, "scripts/git-operation.mjs"))}`;
  let tasks = new SessionTasks(), tail: Promise<unknown> = Promise.resolve();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("git-access", {
    description: "/git-access permissions [repository]: revoke Git consent for the current or named repository and clear refusals",
    handler: async (args, ctx) => {
      const match = /^permissions(?:\s+(.+))?$/.exec(args.trim());
      if (!match) return ctx.ui.notify("usage: /git-access permissions [canonical repository path]", "info");
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Git permissions require the interactive parent");
      // Revocation must still work when Git configuration or helpers are broken.
      const cwd = realpathSync(ctx.cwd), selected = match[1];
      if (selected && (!isAbsolute(selected) || realpathSync(selected) !== selected)) throw new Error("Repository path must be canonical without links");
      const root = gitRepositoryRoot(selected ?? cwd);
      if (selected && selected !== root) throw new Error("Select the exact repository root for revocation");
      await reset(); verify(ctx);
      if (realpathSync(ctx.cwd) !== cwd) throw new Error("Workspace changed during revocation");
      approvals.revoke(root, "git-access");
      ctx.ui.notify("Git permissions revoked for this repository. Existing effects remain.", "info");
    },
  });
  pi.registerTool({
    name: "git_access", label: "Git operation with scoped consent", executionMode: "sequential", exposure: "model-only",
    description: "Git-only approved operations inside Codex. Optional repository selects an exact canonical worktree root, including one created by git_repository_init. branch creates and switches to a NEW branch from current HEAD; stage names up to 1000 explicit repository-relative files; commit requires the exact complete staged paths and a message. push names one configured HTTPS remote and destination branch; optional source_branch selects an existing local branch instead of HEAD, resolved to a reviewed immutable commit. Each push gets proxy access only to its remote DNS name, without a session grant. For confirmed private DNS destinations, private_network=true uses fresh no-dialog LLM task review; explicit manual policies and network denies remain binding. Local branch/stage/commit consent is repository-scoped; each push needs fresh approval for its exact destination and commit. No force, amend, reset, clean, arbitrary arguments or upstream-config change. Hooks and signing remain enabled and confined.",
    promptGuidelines: ["Use git_access directly for authorized Git writes rather than retrying denied Bash or requesting .git access. A project permission is not an instruction to commit or publish: require the user's request for those actions. Inspect ownership, staged changes and project checks first. Supply only explicit files belonging to the requested commit. Do not bypass hooks, use --no-verify, replay through Dunst, or retry blindly after a partial failure. Inspect hook-modified commits before proposing a push. /git-access permissions revokes remembered consent."],
    parameters: Type.Object({ operation: Type.Union([Type.Literal("branch"), Type.Literal("stage"), Type.Literal("commit"), Type.Literal("push")]), repository: Type.Optional(Type.String()), branch: Type.Optional(Type.String()), source_branch: Type.Optional(Type.String()), private_network: Type.Optional(Type.Boolean({ description: "Push only: allow this remote DNS name to resolve to private addresses for this operation. Fresh tool-free task review, no dialog, no saved network grant; explicit manual/deny policies remain binding." })), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 1000 })), message: Type.Optional(Type.String()), remote: Type.Optional(Type.String()), reason: Type.String() }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      const request = validateGitRequest(input), cwd = realpathSync(ctx.cwd), workdir = realpathSync(request.repository ?? cwd);
      if (request.repository !== undefined && workdir !== request.repository) throw new Error("Repository path must be canonical without links");
      return tasks.run(async owned => {
        const run = async () => {
          const validate = () => { owned.throwIfAborted(); verify(ctx); if ((!ctx.hasUI && !request.private_network && !hasAutomaticReview(agentDir, ctx)) || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("git_access")) throw new Error("Git access requires the interactive parent or a configured automatic parent policy in the same workspace"); };
          validate();
          const query = async (action: "inspect" | "execute", expected?: GitSnapshot) => {
            const transaction = expected && process.platform === "linux" ? createGitTransaction(expected, request) : undefined;
            try {
              const paths = transaction ? [transaction.commonDir] : expected ? gitWritePaths(expected, request) : [];
              const roots = expected ? commandWritableRoots(paths, cwd, agentDir, [getPackageDir()]) : [];
              const network = expected && request.operation === "push" ? ["--git-network", JSON.stringify({ host: normalizeHost(new URL(expected.remoteUrl!).hostname), privateNetwork: request.private_network === true })] : [];
              const args = expected ? [...network, "--write-roots", JSON.stringify(roots), ...(transaction ? ["--read-roots", JSON.stringify(transaction.readOnlyRoots)] : []), "-c", command] : ["--offline", "-c", command];
              // Selecting a repository must never widen the shell's workspace.
              // The fixed worker selects Git's cwd, within the original jail.
              const raw = await execute(launcher, args, { cwd, signal: owned, env: { PI_CODING_AGENT_DIR: agentDir }, input: JSON.stringify({ action, request, expected, transaction: transaction?.commonDir }), timeoutMs: action === "execute" ? 300000 : 60000, maxBytes: 1024 * 1024 });
              const output = JSON.parse(raw);
              if (output.error) throw new Error(`${output.error}. ${output.notice ?? ""}`);
              validate();
              if (transaction) publishGitTransaction(transaction);
              return output.result;
            } finally { if (transaction) closeGitTransaction(transaction); }
          };
          const snapshot: GitSnapshot = await query("inspect");
          const binary = serverIdentity("/usr/bin/git", [], cwd);
          const roots = commandWritableRoots(gitWritePaths(snapshot, request), cwd, agentDir, [getPackageDir()]);
          const checkNetwork = () => {
            if (request.operation !== "push") return;
            const host = normalizeHost(new URL(snapshot.remoteUrl!).hostname);
            if (readNetworkPolicy(agentDir).deny.includes(host)) throw new Error(`NETWORK_DENIED: Git destination explicitly denied by network-policy.json; no push performed`);
          };
          checkNetwork();
          const expires = Date.now() + 300000;
          const revalidate = () => { validate(); checkNetwork(); if (Date.now() > expires || fingerprint(serverIdentity("/usr/bin/git", [], cwd)) !== fingerprint(binary)) throw new Error("Git approval expired or executable changed; no operation performed"); commandWritableRoots(roots, cwd, agentDir, [getPackageDir()]); };
          const scoped: ExtensionContext = { ...ctx, cwd: snapshot.root, ui: { ...ctx.ui, select: (title, choices, options) => approvalDialog(ctx, title, choices, options) } };
          const ticket = await approvals.authorize(scoped, {
            auditOperation: request.operation, toolCallId: _id,
            // A broader network request must not evade a human refusal of this push.
            // The immutable request and fresh review detail bind the private capability.
            resource: "git-access", identity: fingerprint([snapshot.identity, binary]), operation: request.operation === "push" ? fingerprint(["push", request.remote, request.branch, snapshot.pushHead ?? snapshot.head, snapshot.remoteUrl]) : "local-branch-stage-commit-v1",
            remember: request.operation !== "push", interactiveOnly: true, automaticWithoutUI: true,
            taskOnly: request.private_network === true,
            title: request.operation === "push" ? "Autoriser ce push uniquement ?" : "Autoriser Git pour ce projet ?",
            detail: `${request.operation === "push" ? "Publication HTTPS, destination et commit exacts ci-dessous. Jamais mémorisée. Proxy limité au seul nom DNS du remote pour ce processus et ses hooks; tous ses ports sont accessibles, sans filtrage des chemins HTTP. Aucun hôte de la liste générale/session n'est ajouté." : "Session/projet autorise les FUTURES créations de branche, indexations de fichiers et commits de ce dépôt, pas les pushs ni un shell."}\n${request.private_network ? "Le nom DNS peut résoudre vers des adresses privées/locales. Autorisation du nom, pas épinglage des adresses IP; les autres noms, IP littérales, sockets directs et sockets Unix de l'hôte restent bloqués." : "Les destinations privées restent bloquées."}\nHooks et contrôles dans Codex, exécution limitée à 5 min. Aucun droit ajouté à Bash.\n${JSON.stringify({ ...request, repository: snapshot.root, head: snapshot.head, ...(snapshot.remoteUrl ? { destination: snapshot.remoteUrl, commit: snapshot.pushHead ?? snapshot.head } : {}) })}`,
            revalidate,
          }, owned, ctx);
          ticket();
          const current: GitSnapshot = await query("inspect");
          if (current.stamp !== snapshot.stamp || current.identity !== snapshot.identity) throw new Error("Git state changed during approval; no operation performed");
          ticket();
          const result = await query("execute", snapshot);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
        };
        const result = tail.then(run, run); tail = result.catch(() => undefined); return result;
      }, signal);
    },
  });
}
