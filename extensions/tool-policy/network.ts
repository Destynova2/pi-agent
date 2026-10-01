import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { networkHosts, normalizeHost, readNetworkPolicy } from "../../scripts/codex-network.mjs";

export function registerNetworkAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void) {
  let root: string | undefined;
  let grantPath: string | undefined;
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const refused = new Set<string>();
  const reset = () => {
    epoch++;
    root = undefined;
    refused.clear();
    if (process.env.PI_CODEX_NETWORK_GRANTS === grantPath) delete process.env.PI_CODEX_NETWORK_GRANTS;
    if (grantPath) rmSync(grantPath, { force: true });
    grantPath = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    delete process.env.PI_CODEX_NETWORK_GRANTS; // Never import grants from a parent/previous session.
    root = realpathSync(ctx.cwd);
  });
  pi.on("session_shutdown", reset);
  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    description: "Request additional exact public DNS hosts for subsequent sandbox commands in this workspace/session. Already allowed hosts need no prompt; new hosts require the human. No filesystem escalation, wildcard, private-network or automatic command retry.",
    parameters: Type.Object({
      hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 10 }),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    async execute(_id, input, signal, _onUpdate, ctx) {
      const generation = epoch;
      const run = async () => {
        verify(ctx);
        if (!root || root !== realpathSync(ctx.cwd) || generation !== epoch || signal?.aborted) throw new Error("Network request is stale or aborted");
        const requested = [...new Set(input.hosts.map(normalizeHost))];
        const policy = readNetworkPolicy(agentDir);
        if (requested.some(host => policy.deny.includes(host))) throw new Error("A requested host is explicitly denied by network-policy.json; it cannot be approved");
        const allowed = networkHosts(agentDir, root, grantPath);
        const missing = requested.filter(host => !allowed.includes(host));
        if (missing.some(host => refused.has(host))) throw new Error("Network access was refused earlier in this session; no repeated prompt");
        if (missing.length) {
          if (!ctx.hasUI) throw new Error(`Network access requires human approval: ${missing.join(", ")}. No UI available; denied. Configure network-policy.json outside Pi for headless use.`);
          if (new Set([...allowed, ...missing]).size > 128) throw new Error("Network host limit reached (128)");
          let abort = () => {};
          const aborted = new Promise<false>(resolve => {
            abort = () => resolve(false);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
          let approved = false;
          try {
            approved = await Promise.race([
              ctx.ui.confirm("Allow additional network destinations?", `Hosts: ${missing.join(", ")}\nWorkspace: ${root}\nScope: new commands in this Pi session; proxy traffic to these hosts on any port, including uploads. Filesystem jail stays unchanged.\nAgent justification: ${input.reason}`, { signal }),
              aborted,
            ]);
          } finally { signal?.removeEventListener("abort", abort); }
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
        return { content: [{ type: "text" as const, text: `Network destinations available to new sandbox commands: ${requested.join(", ")}. Existing commands keep their old proxy policy. No command was retried.` }], details: undefined };
      };
      const result = tail.then(run, run);
      tail = result.catch(() => undefined);
      return result;
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    let description: string;
    try { description = `Automatically allowed public hosts: ${networkHosts(agentDir, ctx.cwd, grantPath).join(", ") || "none"}.`; }
    catch { description = "Network policy cannot be read; sandbox launches will fail closed."; }
    event.systemPromptOptions.sections.network_access = `${description} Network commands must use Codex's managed HTTP(S) proxy; direct sockets/private networks are blocked. For another exact public host, call request_network_access with hosts and reason. Only the human can approve additional hosts for this workspace/session. No UI means denial. Do not rerun a failed command automatically: earlier steps may already have had effects. Network grants never authorize filesystem escape or otherwise unsupported tools.`;
  });
}
