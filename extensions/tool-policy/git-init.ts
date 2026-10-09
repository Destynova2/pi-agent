import { hasAutomaticReview } from "../../lib/approval-review.ts";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { approvalDialog } from "../../lib/approval-dialog.ts";
import { closeGitInitStage, createGitInitStage, inspectGitInitTarget, publishGitInit, validateGitInit } from "../../lib/git-init.ts";
import { McpApprovals, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { commandWritableRoots } from "../../scripts/codex-shell.mjs";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function registerGitInit(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir), launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const command = [process.execPath, join(runtimeRoot, "scripts/git-init.mjs")].map(quote).join(" ");
  let tasks = new SessionTasks();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, reset);
  pi.registerCommand("git-init", {
    description: "/git-init reset: cancel pending repository initialization and clear refusals",
    async handler(args, ctx) {
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Git initialization requires the interactive parent");
      if (args.trim() !== "reset") return ctx.ui.notify("usage: /git-init reset", "info");
      await reset(); ctx.ui.notify("Pending repository initialization canceled. Existing repositories remain unchanged.", "info");
    },
  });
  pi.registerTool({
    name: "git_repository_init", label: "Initialize a separate Git repository", executionMode: "sequential", exposure: "model-only",
    description: "Create a new SHA-1 Git repository in an existing canonical directory after exact one-time consent. Creates an EMPTY ROOT COMMIT on the named initial branch, an explicit local author identity and one HTTPS remote. Existing files remain untracked; any .git or .jj metadata is refused, never replaced. Runs Git, templates, hooks and signing offline inside Codex, then publishes only validated metadata. No push, history import, global config edit or Bash grant. Use git_access with repository for subsequent branches, explicit-file commits and separately approved pushes.",
    promptGuidelines: ["For an empty main and populated develop, create a separate directory in the workspace or private TMPDIR, then call this tool with branch=main and the requested Conventional Commit message. Preserve the source repository. Review and copy the intended source content, create develop with git_access using repository, and stage only reviewed explicit paths. Publishing main while develop is checked out requires source_branch=main on the push. Review content, secrets and project checks before any push. Do not claim that init validates remote access or imports changes. A missing parent directory must be created with ordinary confined tools first."],
    parameters: Type.Object({ repository: Type.String(), branch: Type.String(), remote: Type.String(), url: Type.String(), author_name: Type.String(), author_email: Type.String(), message: Type.String(), reason: Type.String() }, { additionalProperties: false }),
    async execute(id, input, signal, _update, ctx) {
      const request = validateGitInit(input), cwd = realpathSync(ctx.cwd);
      return tasks.run(async owned => {
        const identity = inspectGitInitTarget(request.repository), binary = serverIdentity("/usr/bin/git", [], cwd), expires = Date.now() + 300000;
        const validate = () => {
          owned.throwIfAborted(); verify(ctx);
          if ((!ctx.hasUI && !hasAutomaticReview(agentDir, ctx)) || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("git_repository_init")) throw new Error("Git initialization requires the active interactive parent or a configured automatic parent policy");
          if (Date.now() > expires || inspectGitInitTarget(request.repository) !== identity || fingerprint(serverIdentity("/usr/bin/git", [], cwd)) !== fingerprint(binary)) throw new Error("Git initialization request expired or destination changed");
          commandWritableRoots([join(request.repository, ".git")], cwd, agentDir, [getPackageDir()]);
        };
        validate();
        const scoped: ExtensionContext = { ...ctx, cwd: request.repository, ui: { ...ctx.ui, select: (title, choices, options) => approvalDialog(ctx, title, choices, options) } };
        const ticket = await approvals.authorize(scoped, {
          resource: "git-init", auditOperation: "initialize", toolCallId: id, identity: fingerprint([identity, binary]), operation: fingerprint(request), remember: false, interactiveOnly: true, automaticWithoutUI: true,
          title: "Initialiser ce nouveau dépôt Git ?",
          detail: `Cette destination uniquement, avec un commit racine vide, une identité locale et un remote HTTPS. Aucun fichier existant indexé, aucune modification du dépôt source, aucun push. Hooks et signature restent actifs dans le sandbox.\n${JSON.stringify(request)}`,
          revalidate: validate,
        }, owned, ctx);
        ticket();
        const stage = createGitInitStage();
        try {
          const roots = commandWritableRoots([stage.metadata], stage.worktree, agentDir, [getPackageDir()]);
          const raw = await execute(launcher, ["--write-roots", JSON.stringify(roots), "--offline", "-c", command], { cwd: stage.worktree, signal: owned, input: JSON.stringify(request), timeoutMs: 240000, maxBytes: 16384 });
          const output = JSON.parse(raw);
          if (output.error) throw new Error(output.error);
          validate(); ticket();
          const result = publishGitInit(stage, request, identity, output.result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
        } finally { closeGitInitStage(stage); }
      }, signal);
    },
  });
}
