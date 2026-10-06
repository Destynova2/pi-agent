import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDirectory, buildSandboxArgs, kvmStatus, prepareBuild } from "../../lib/build-sandbox.ts";
import { McpApprovals, approvalDisplayText, fingerprint } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

/** A fixed project build with a separate, explicitly approved device/network policy. */
export function registerBuildAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void,
  dependencies = { execute: runProcess, inspectKvm: kvmStatus }) {
  const approvals = new McpApprovals(agentDir);
  let tasks = new SessionTasks(), busy = false;
  const reset = async () => {
    approvals.reset();
    const previous = tasks; tasks = new SessionTasks();
    await previous.close();
  };
  for (const event of ["session_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) pi.on(event, reset);
  pi.registerCommand("build-access", {
    description: "/build-access reset: cancel the build and pending approvals, clear refusals",
    handler: async (args, ctx) => {
      if (args.trim() !== "reset") return ctx.ui.notify("usage: /build-access reset", "info");
      await reset(); ctx.ui.notify("Build stopped and pending consent cleared. Existing artifacts are retained.", "info");
    },
  });
  pi.registerTool({
    name: "request_build_access", label: "Request KVM image build", executionMode: "sequential",
    description: "Ask the human to run ansible-playbook -i localhost, ansible/build.yml once in the current Linux project. Dedicated Bubblewrap sandbox: only .cache/, output/ and private temporary storage are writable, /dev/kvm is exposed, and the FULL host network is available (local services, TCP/UDP and Unix sockets), without the ordinary public-host proxy restrictions. Project build code and dependencies can use that network; inspect them first. Default duration 120 minutes, maximum 240. Requires host KVM permissions, /usr/bin/bwrap, /usr/bin/python3 and installed ansible-playbook. Foreground and supervised: cancel or /build-access reset stops the process tree. Never use for arbitrary commands, harness changes, delegated/headless execution or repeated unchanged failures. Logs may contain secrets and are stored privately; a successful exit still requires artifact validation.",
    promptGuidelines: [
      "When an authorized Packer/Ansible image build needs /dev/kvm, use this capability after inspecting ansible/build.yml, packer/, config/ and ansible.cfg. No fabricated Bash failure is required. Ordinary Bash, write_paths and public network grants cannot provide this capability.",
      "Keep the task open until completion and verify artifacts. Inspect private logs carefully on failure without exposing credentials. Approval never proves KVM works: the worker must create a VM inside the sandbox before starting Ansible.",
      "If a capability is missing, record the precise blocker and propose a reviewed source patch with regression checks. Never edit the live harness, auto-approve a grant or bypass the current sandbox to improve it.",
    ],
    parameters: Type.Object({
      timeout_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }, { additionalProperties: false }),
    async execute(id, input, signal, onUpdate, ctx) {
      if (Object.keys(input).some(key => !["timeout_minutes", "reason"].includes(key)) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500) throw new Error("Invalid build request; only reason and timeout_minutes are accepted");
      const minutes = input.timeout_minutes ?? 120, reason = input.reason;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Build timeout must be 1–240 minutes");
      if (busy) throw new Error("A build or its approval is already running");
      busy = true;
      try {
        return await tasks.run(async owned => {
          const cwd = realpathSync(ctx.cwd);
          const validate = () => {
            owned.throwIfAborted(); verify(ctx);
            if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("request_build_access")) throw new Error("Build access requires the interactive parent in the same workspace");
            const kvm = dependencies.inspectKvm();
            if (!kvm.available) throw new Error(`KVM_UNAVAILABLE on host: ${kvm.reason}. Check /dev/kvm and the user's existing access on the host; no automatic chmod, module load or retry.`);
          };
          validate();
          const plan = prepareBuild(cwd, agentDir), identity = fingerprint(plan), expires = Date.now() + 300_000;
          const title = "Autoriser ce build KVM ?";
          const detail = `Une fois, ${minutes} min. /dev/kvm ; réseau COMPLET de l’hôte (TCP/UDP, sockets, services locaux) accessible au code et aux dépendances du build.\nÉcritures : .cache/, output/, temporaire privé. Autres fichiers en lecture seule.\nCommande : ${JSON.stringify([plan.executable.command, "-i", "localhost,", "ansible/build.yml"])}\nSources : ${plan.sourceSha256.slice(0, 16)}\nMotif : ${reason}`;
          const revalidate = () => {
            validate();
            if (Date.now() > expires) throw new Error("Build approval expired");
            const visible = approvalDisplayText(`${title}\nProjet : ${JSON.stringify(cwd)}\n${detail}`);
            if (wrapTextWithAnsi(visible, Math.max(20, (process.stdout.columns ?? 80) - 4)).length > Math.max(1, (process.stdout.rows ?? 24) - 8)) throw new Error("Build approval does not fit the terminal; shorten the reason or enlarge the window so the full operation and both choices are visible");
            if (fingerprint(prepareBuild(cwd, agentDir)) !== identity) throw new Error("Build sources, executable or worker changed during approval");
          };
          const ticket = await approvals.authorize(ctx, {
            resource: "build-access", auditOperation: "kvm-build", toolCallId: id, identity,
            operation: fingerprint({ cwd, minutes }), remember: false, interactiveOnly: true,
            title, detail,
            revalidate,
          }, owned);
          ticket();
          for (const name of [".cache", "output"]) {
            const path = join(cwd, name);
            try { mkdirSync(path, { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            buildDirectory(path);
          }
          const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-kvm-build-")));
          const scratch = join(directory, "tmp"); mkdirSync(scratch, { mode: 0o700 });
          const logPath = join(directory, "build.log"), fd = openSync(logPath, "wx", 0o600);
          const details = { cwd, sourceSha256: plan.sourceSha256, timeoutMinutes: minutes, logPath };
          const journal = (status: string) => pi.appendEntry("kvm_build", { ...details, status, at: new Date().toISOString() });
          let bytes = 0;
          const progress = () => onUpdate?.({ content: [{ type: "text", text: `KVM build running (${bytes} output bytes). Private log: ${logPath}. Completion and artifact validation still pending.` }], details: { ...details, status: "running" } });
          const timer = setInterval(() => { try { progress(); } catch { clearInterval(timer); } }, 15000);
          const log = (chunk: Buffer) => {
            bytes += chunk.length;
            for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset, chunk.length - offset);
          };
          try {
            journal("started"); progress();
            // Remove inherited hooks, credentials, proxy settings and agent state before even starting bwrap.
            const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])) as NodeJS.ProcessEnv;
            Object.assign(env, { PATH: plan.path, LANG: "C.UTF-8" });
            await dependencies.execute(plan.backend.command, buildSandboxArgs(plan, scratch), {
              cwd, env, signal: owned, timeoutMs: minutes * 60_000, maxBytes: 32 * 1024 * 1024,
              onStdout: log, onStderr: log,
            });
            journal("completed");
            return { content: [{ type: "text" as const, text: `Build command completed successfully. Verify output/ artifacts before declaring the image ready. Private log: ${logPath}. One-shot KVM/network access consumed.` }], details: { ...details, status: "completed" } };
          } catch (error) {
            log(Buffer.from(`\n[supervisor] ${(error as Error).message}\n`));
            const status = owned.aborted ? "canceled" : /deadline exceeded/.test((error as Error).message) ? "timed_out" : "failed";
            journal(status);
            throw new Error(`Build ${status}. Private log: ${logPath}. Inspect partial artifacts and the log before requesting another build; no automatic retry.`);
          } finally { clearInterval(timer); closeSync(fd); }
        }, signal);
      } finally { busy = false; }
    },
  });
}
