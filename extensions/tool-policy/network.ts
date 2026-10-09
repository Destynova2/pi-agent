import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { reviewApproval } from "../../lib/approval-review.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { runProcess } from "../../lib/process.ts";
import { runtimeRoot } from "../../lib/runtime-paths.mjs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { networkHosts, normalizeHost, readNetworkPolicy } from "../../scripts/codex-network.mjs";

export function registerNetworkAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  let root: string | undefined;
  let grantPath: string | undefined;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const refused = new Set<string>();
  let tasks = new SessionTasks();
  const reset = () => {
    epoch++;
    root = undefined;
    refused.clear();
    if (process.env.PI_CODEX_NETWORK_GRANTS === grantPath) delete process.env.PI_CODEX_NETWORK_GRANTS;
    if (grantPath) rmSync(grantPath, { force: true });
    grantPath = undefined;
    const previous = tasks; tasks = new SessionTasks(); return previous.close();
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    delete process.env.PI_CODEX_NETWORK_GRANTS; // Never import grants from a parent/previous session.
    root = realpathSync(ctx.cwd);
  });
  pi.on("session_shutdown", reset);
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"] as const) pi.on(event, reset);
  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    description: "With command: qualify and execute that exact command once in Codex with only the named public hosts for its lifetime. Tool-free LLM review, no dialog or stored grant, including without UI. Existing explicit denies win; uploads/all ports are included, private networks and host sockets remain blocked. Without command: legacy session grant, requiring manual human consent. No filesystem escalation or automatic retry.",
    promptGuidelines: ["For an exact URL supplied by the user, use web_fetch directly. Otherwise supply command, hosts and reason together for a one-command grant. Inspect partial effects before requesting a retry. Do not use a session grant for a single download.", "Use clients that honor the managed HTTP_PROXY/HTTPS_PROXY environment. Direct DNS probes do not validate proxied HTTP(S) access, and DNS failures are not website HTTP refusals. Never disable the proxy or request an unrestricted host shell to repair resolution."],
    parameters: Type.Object({
      hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 10 }),
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    executionMode: "sequential",
    async execute(_id, input, signal, _onUpdate, ctx) {
      const audit = new PermissionAudit(agentDir, ctx, { resource: "network-access", operation: input.command === undefined ? "allow-hosts" : "run-command", toolCallId: _id, payload: input, targets: input.hosts });
      try {
        const generation = epoch;
        const hosts = [...input.hosts], reason = input.reason;
        if (input.command !== undefined) {
          const command = input.command, cwd = realpathSync(ctx.cwd);
          if (!command.trim() || command.length > 8000 || command.includes("\0")) throw new Error("Expected a bounded command");
          const requested = [...new Set(hosts.map(normalizeHost))].sort();
          const expires = Date.now() + 300_000;
          return await tasks.run(async owned => {
            const validate = () => {
              owned.throwIfAborted(); verify(ctx);
              if (process.env.PI_SUBAGENT_CHILD || root !== cwd || realpathSync(ctx.cwd) !== cwd || generation !== epoch || Date.now() > expires || pi.getActiveTools && !pi.getActiveTools().includes("request_network_access")) throw new Error("Network command is stale, expired or unavailable in this parent session");
              if (requested.some(host => readNetworkPolicy(agentDir).deny.includes(host))) throw new Error("A requested host is explicitly denied by network-policy.json");
              if (requested.some(host => refused.has(host))) throw new Error("Network access was refused earlier in this session");
            };
            validate();
            const review = await reviewApproval(agentDir, ctx, { resource: "network-access", operation: "run-command", detail: JSON.stringify({ command, cwd, hosts: requested, scope: "this command and descendants only, up to 120 seconds; proxy access on any port, including uploads; no stored grant; ordinary workspace writes and filesystem read policy", reason }) }, audit, owned, true);
            review.check(); validate();
            if (review.decision !== "allow") { audit.finish("denied", "policy", "once"); throw new Error("Automatic review disabled by manual policy; no network command executed"); }
            audit.finish("granted", "policy", "once");
            const output: Buffer[] = [];
            try {
              await execute(join(runtimeRoot, "scripts/codex-shell.mjs"), ["--network-hosts", JSON.stringify(requested), "-c", command], {
                cwd, signal: owned, timeoutMs: 120_000, maxBytes: 1024 * 1024, env: { PI_CODING_AGENT_DIR: agentDir }, onStdout: chunk => output.push(chunk), onStderr: chunk => output.push(chunk),
              });
            } catch (error) { throw new Error(`${(error as Error).message}\n${Buffer.concat(output).toString("utf8").slice(-6000)}\nOne-command network access consumed; no automatic retry.`); }
            return { content: [{ type: "text" as const, text: `${Buffer.concat(output).toString("utf8").slice(-60000)}\nOne-command network access consumed; no session grant saved.` }], details: undefined };
          }, signal);
        }
        const run = async () => {
          verify(ctx);
          if (!root || root !== realpathSync(ctx.cwd) || generation !== epoch || signal?.aborted) throw new Error("Network request is stale or aborted");
          const requested = [...new Set(hosts.map(normalizeHost))];
          const policy = readNetworkPolicy(agentDir);
          if (requested.some(host => policy.deny.includes(host))) { audit.finish("denied", "policy"); throw new Error("A requested host is explicitly denied by network-policy.json; it cannot be approved"); }
          const allowed = networkHosts(agentDir, root, grantPath);
          const missing = requested.filter(host => !allowed.includes(host));
          if (missing.some(host => refused.has(host))) { audit.finish("denied", "refusal_cache"); throw new Error("Network access was refused earlier in this session; no repeated prompt"); }
          if (missing.length) {
            if (new Set([...allowed, ...missing]).size > 128) throw new Error("Network host limit reached (128)");
            const review = await reviewApproval(agentDir, ctx, { resource: "network-access", operation: "allow-hosts", detail: JSON.stringify({ hosts: missing, scope: "session-wide proxy access on any port, including uploads", reason }) }, audit, signal);
            if (review.decision === "allow") { audit.finish("denied", "policy", "once"); throw new Error("Automatic network access requires command for a one-command grant; no session grant saved"); }
            if (!ctx.hasUI) { audit.finish("denied", "unavailable"); throw new Error("No UI for legacy session grant; supply command for automatic one-command review"); }
            let abort = () => {};
            const aborted = new Promise<false>(resolve => {
              abort = () => resolve(false);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
            let approved = false;
            try {
              audit.prompted();
              approved = await Promise.race([
                audit.run(() => ctx.ui.confirm("Allow additional network destinations?", `Hosts: ${missing.join(", ")}\nWorkspace: ${root}\nScope: new commands in this Pi session; proxy traffic to these hosts on any port, including uploads. Filesystem jail stays unchanged.\nAgent justification: ${reason}`, { signal })),
                aborted,
              ]);
              audit.answered(signal?.aborted ? "cancel" : approved ? "allow" : "deny", "session");
            } finally { signal?.removeEventListener("abort", abort); }
            review.check();
            verify(ctx);
            if (generation !== epoch || signal?.aborted) throw new Error("Network request became stale or aborted; no grant saved");
            if (!approved) {
              missing.forEach(host => refused.add(host));
              throw new Error("Network access refused; no grant saved");
            }
            // Re-read after the dialog: new explicit denies must win over the answer.
            const latest = readNetworkPolicy(agentDir);
            if (requested.some(host => latest.deny.includes(host))) throw new Error("Network policy changed while awaiting approval");
            const directory = join(realpathSync(agentDir), "network-grants");
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            if (realpathSync(directory) !== directory) throw new Error("Network grant directory cannot be a symlink");
            const destination = grantPath ?? join(directory, `${randomUUID()}.json`);
            const temporary = join(directory, `${randomUUID()}.tmp`);
            // Store approved additions only: removing a baseline host must actually revoke it.
            const previous = grantPath ? networkHosts(agentDir, root, grantPath).filter(host => !latest.allow.includes(host)) : [];
            try {
              writeFileSync(temporary, JSON.stringify({ cwd: root, hosts: [...new Set([...previous, ...missing])] }), { flag: "wx", mode: 0o600 });
              renameSync(temporary, destination);
            } finally { rmSync(temporary, { force: true }); }
            grantPath = destination;
            process.env.PI_CODEX_NETWORK_GRANTS = destination;
          }
          audit.finish("granted", missing.length ? "human" : requested.every(host => policy.allow.includes(host)) ? "policy" : "session", missing.length || !requested.every(host => policy.allow.includes(host)) ? "session" : "policy");
          return { content: [{ type: "text" as const, text: `Network destinations available to new sandbox commands: ${requested.join(", ")}. Existing commands keep their old proxy policy. No command was retried.` }], details: undefined };
        };
        const result = tail.then(run, run);
        tail = result.catch(() => undefined);
        return await result;
      } catch (error) { audit.fail(signal, error); throw error; }
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!root) { verify(ctx); root = realpathSync(ctx.cwd); }
    let description: string;
    try { description = `Automatically allowed public hosts: ${networkHosts(agentDir, ctx.cwd, grantPath).join(", ") || "none"}.`; }
    catch { description = "Network policy cannot be read; sandbox launches will fail closed."; }
    event.systemPromptOptions.sections.network_access = `${description} Ordinary network commands must use Codex's managed HTTP(S) proxy; direct sockets/private networks are blocked. git_access push with private_network=true separately qualifies one configured private remote DNS name; it does not grant Bash or session networking. Read an exact user-supplied public URL with web_fetch. For additional access use request_network_access with command, hosts and reason: tool-free LLM qualification executes only that command, with only those hosts, no dialog and no stored grant. Explicit denies remain binding. Omitting command is the legacy human-approved session mode, never an automatic session grant. Inspect partial effects before any retry. For offline provider validation or tests requiring Unix sockets, use run_isolated with explicit copied inputs and installed standalone binaries; no host sockets or external network are exposed. Never bypass an outer sandbox restriction.`;
  });
}
