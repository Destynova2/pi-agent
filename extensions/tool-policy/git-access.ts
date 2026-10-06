import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { closeGitTransaction, createGitTransaction, publishGitTransaction } from "../../lib/git-transaction.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";
import { networkHosts, normalizeHost } from "../../scripts/codex-network.mjs";
import { gitRepositoryRoot, gitWritePaths, validateGitRequest, type GitSnapshot } from "./git-access-core.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerGitAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(agentDir, "scripts/codex-shell.mjs");
  const command = `${quote(process.execPath)} ${quote(join(agentDir, "scripts/git-operation.mjs"))}`;
  let tasks = new SessionTasks(), tail: Promise<unknown> = Promise.resolve();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("git-access", {
    description: "/git-access permissions: revoke Git consent for this repository and clear refusals",
    handler: async (args, ctx) => {
      if (args.trim() !== "permissions") return ctx.ui.notify("usage: /git-access permissions", "info");
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Git permissions require the interactive parent");
      // Revocation must still work when Git configuration or helpers are broken.
      const cwd = realpathSync(ctx.cwd), root = gitRepositoryRoot(cwd);
      await reset(); verify(ctx);
      if (realpathSync(ctx.cwd) !== cwd) throw new Error("Workspace changed during revocation");
      approvals.revoke(root, "git-access");
      ctx.ui.notify("Git permissions revoked for this repository. Existing effects remain.", "info");
    },
  });
  pi.registerTool({
    name: "git_access", label: "Git operation with scoped consent", executionMode: "sequential", exposure: "model-only",
    description: "Git-only approved operations inside Codex: branch creates and switches to a NEW branch from current HEAD; stage names explicit repository-relative files (not directories); commit requires the exact complete list of staged paths and a message; push names one configured HTTPS remote and destination branch. Local branch/stage/commit consent can be remembered for the repository; push always asks once for the exact destination and commit ID. No force, amend, reset, clean, arbitrary arguments or upstream-config change. Does not need a previous failed Bash call. Hooks and signing stay enabled and confined.",
    promptGuidelines: ["Use git_access directly for authorized Git writes rather than retrying denied Bash or requesting .git access. A project permission is not an instruction to commit or publish: require the user's request for those actions. Inspect ownership, staged changes and project checks first. Supply only explicit files belonging to the requested commit. Do not bypass hooks, use --no-verify, replay through Dunst, or retry blindly after a partial failure. Inspect hook-modified commits before proposing a push. /git-access permissions revokes remembered consent."],
    parameters: Type.Object({ operation: Type.Union([Type.Literal("branch"), Type.Literal("stage"), Type.Literal("commit"), Type.Literal("push")]), branch: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100 })), message: Type.Optional(Type.String()), remote: Type.Optional(Type.String()), reason: Type.String() }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      const request = validateGitRequest(input), cwd = realpathSync(ctx.cwd);
      return tasks.run(async owned => {
        const run = async () => {
          const validate = () => { owned.throwIfAborted(); verify(ctx); if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("git_access")) throw new Error("Git access requires the interactive parent in the same workspace"); };
          validate();
          const query = async (action: "inspect" | "execute", expected?: GitSnapshot) => {
            const transaction = expected && process.platform === "linux" ? createGitTransaction(expected, request) : undefined;
            try {
              const paths = transaction ? [transaction.commonDir] : expected ? gitWritePaths(expected, request) : [];
              const roots = expected ? commandWritableRoots(paths, cwd, agentDir, [getPackageDir()]) : [];
              const args = expected ? ["--write-roots", JSON.stringify(roots), ...(transaction ? ["--read-roots", JSON.stringify(transaction.readOnlyRoots)] : []), "-c", command] : ["--offline", "-c", command];
              const raw = await execute(launcher, args, { cwd, signal: owned, input: JSON.stringify({ action, request, expected, transaction: transaction?.commonDir }), timeoutMs: action === "execute" ? 300000 : 60000, maxBytes: 1024 * 1024 });
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
            if (!networkHosts(agentDir, cwd, process.env.PI_CODEX_NETWORK_GRANTS).includes(host)) throw new Error(`Git destination needs request_network_access for ${host}; no push performed`);
          };
          checkNetwork();
          const expires = Date.now() + 300000;
          const revalidate = () => { validate(); checkNetwork(); if (Date.now() > expires || fingerprint(serverIdentity("/usr/bin/git", [], cwd)) !== fingerprint(binary)) throw new Error("Git approval expired or executable changed; no operation performed"); commandWritableRoots(roots, cwd, agentDir, [getPackageDir()]); };
          const scoped: ExtensionContext = { ...ctx, cwd: snapshot.root, ui: { ...ctx.ui, select: async (title, choices, options) => {
            if (wrapTextWithAnsi(title, Math.max(20, (process.stdout.columns ?? 80) - 4)).length > Math.max(1, (process.stdout.rows ?? 24) - choices.length - 6)) throw new Error("Git approval does not fit the terminal; shorten the request or enlarge the window. Nothing executed.");
            return ctx.ui.select(title, choices, options);
          } } };
          const ticket = await approvals.authorize(scoped, {
            auditOperation: request.operation, toolCallId: _id,
            resource: "git-access", identity: fingerprint([snapshot.identity, binary]), operation: request.operation === "push" ? fingerprint(["push", request.remote, request.branch, snapshot.head, snapshot.remoteUrl]) : "local-branch-stage-commit-v1",
            remember: request.operation !== "push", interactiveOnly: true,
            title: request.operation === "push" ? "Autoriser ce push uniquement ?" : "Autoriser Git pour ce projet ?",
            detail: `${request.operation === "push" ? "Publication HTTPS, destination et commit exacts ci-dessous. Jamais mémorisée." : "Session/projet autorise les FUTURES créations de branche, indexations de fichiers et commits de ce dépôt, pas les pushs ni un shell."}\nHooks et contrôles dans Codex, exécution limitée à 5 min. Aucun droit ajouté à Bash.\n${JSON.stringify({ ...request, head: snapshot.head, ...(snapshot.remoteUrl ? { destination: snapshot.remoteUrl } : {}) })}`,
            revalidate,
          }, owned);
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
