import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { approvalDisplayText, fingerprint, McpApprovals, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";

const commands = new Set("build commit create diff events exec history images info init inspect kill logs pause port ps pull push rename restart rm rmi run search start stats stop tag top unpause untag update version wait".split(" "));
const groups: Record<string, Set<string>> = {
  container: new Set("commit create diff exec exists init inspect kill list logs pause port prune rename restart rm run start stats stop top unpause update wait".split(" ")),
  image: new Set("build diff exists history inspect list prune pull push rm search tag tree untag".split(" ")),
  pod: new Set("clone create exists inspect kill pause prune ps restart rm start stats stop top unpause".split(" ")),
  network: new Set("connect create disconnect exists inspect ls prune reload rm update".split(" ")),
  volume: new Set("create exists inspect ls prune rm".split(" ")),
  kube: new Set(["play", "down"]),
  healthcheck: new Set(["run"]),
  system: new Set(["df", "info"]),
};
// Engine operations only. No host helper, endpoint override or client-side output file.
const forbidden = new Set("--connection --url --identity --ssh --module --remote --root --runroot --runtime --hooks-dir --config --out --log-level --storage-opt --storage-driver --tmpdir --events-backend --syslog --cgroup-manager --conmon --network-cmd-path --volumepath --db-backend --transient-store --tls-ca --tls-cert --tls-details --tls-key --cidfile --iidfile --pod-id-file --logfile --output".split(" "));
const parameters = Type.Object({
  args: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 128 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
  env_from_container: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "For create only: copy this container's environment privately over stdin, then verify equality. Full container ID required. Do not supply env flags or secret values." })),
}, { additionalProperties: false });
type Request = Static<typeof parameters>;
const path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
export const PODMAN_PROJECT_CHOICE = "Toujours autoriser le moteur Podman local pour ce projet";

function sshIdentity(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error("Unsafe Podman SSH identity file");
  // Reading the key may change atime; that does not change the authorized identity.
  return fingerprint({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
}

function outside(cwd: string, file: string) {
  const rel = relative(cwd, realpathSync(file));
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))) throw new Error("Podman runtime/configuration must be outside the writable workspace");
}

function validateRequest(input: Request): Request {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 8192) throw new Error("Podman request exceeds 8192 bytes");
  const request = JSON.parse(serialized) as Request;
  if (Object.keys(request).some(key => !["args", "reason", "timeout_seconds", "env_from_container"].includes(key)) ||
      typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1000 ||
      !Array.isArray(request.args) || !request.args.length || request.args.length > 128 ||
      request.args.some(arg => typeof arg !== "string" || !arg || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg))) throw new Error("Invalid Podman request");
  if (request.timeout_seconds !== undefined && (!Number.isInteger(request.timeout_seconds) || request.timeout_seconds < 1 || request.timeout_seconds > 1800)) throw new Error("Podman deadline must be 1–1800 seconds");
  const [command, subcommand] = request.args;
  if (request.env_from_container !== undefined) {
    if (typeof request.env_from_container !== "string" || !/^[a-f0-9]{64}$/.test(request.env_from_container) ||
        !(command === "create" || command === "container" && subcommand === "create")) throw new Error("env_from_container requires create and a full container ID");
    if (request.args.some(arg => /^--(?:env|unsetenv|secret|http-proxy)(?:[-=]|$)/.test(arg) || /^-[^-]*e/.test(arg))) throw new Error("Environment overrides are forbidden with env_from_container; the bridge supplies the env-file and unsetenv-all flags");
  }
  if (!commands.has(command) && !groups[command]?.has(subcommand)) throw new Error("Unsupported Podman engine command. Host helpers, compose, machine SSH and client file transfers are excluded");
  for (const arg of request.args) {
    if (arg === "--") break;
    if (forbidden.has(arg.split("=")[0]) || /^-[^-]*c/.test(arg)) throw new Error("Podman connection, host execution and client output overrides are forbidden; use -- before container command arguments");
  }
  return request;
}

// Only this private transport reads secret values. Nothing from its subprocesses
// (including errors) reaches the conversation, reviewer or permission audit.
function containerEnvironment(raw: string): string[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 4096) throw new Error("Invalid environment");
  const entries = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) || /[\r\n\0]/.test(value)) throw new Error("Environment cannot be transferred as an env-file");
    const name = value.slice(0, value.indexOf("="));
    if (entries.has(name) && entries.get(name) !== value) throw new Error("Conflicting environment entries");
    entries.set(name, value);
  }
  return [...entries.values()].sort();
}

/** Generic engine access with exact approval or explicit project consent, no host shell. */
export function registerPodmanAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir);
  let tasks = new SessionTasks();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("podman-access", {
    description: "/podman-access reset: cancel pending calls; permissions: revoke project engine access",
    handler: async (args, ctx) => {
      if (args.trim() === "permissions") {
        verify(ctx);
        if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("Podman permissions require the interactive parent");
        approvals.revoke(ctx.cwd, "podman-access"); await reset();
        ctx.ui.notify("Podman project permissions revoked; pending calls canceled. Existing engine effects may remain.", "info"); return;
      }
      if (args.trim() !== "reset") return ctx.ui.notify("usage: /podman-access reset | permissions", "info");
      await reset(); ctx.ui.notify("Pending Podman calls canceled; existing containers/build effects may remain.", "info");
    },
  });
  pi.registerTool({
    name: "request_podman_access", label: "Podman engine", exposure: "model-only", executionMode: "sequential", parameters,
    description: "Run one approved Podman engine command from this workspace through the host CLI. Generic build/run/exec, containers, images, pods, networks, volumes and kube play/down; no W4re dependency. Supply argv without podman, shell syntax or global flags. Uses the configured default local Unix/loopback SSH connection, pinned for the call. Default 300 seconds, maximum 1800. Bounded stdout/stderr are returned, including errors, and may contain secrets. For create, env_from_container privately copies an existing container's environment over stdin and verifies it; only the created ID and equality result are returned. No arbitrary stdin/TTY, host shell, compose, machine SSH, connection changes or client output files. Every call uses /approvals policy or human approval unless the user explicitly saved engine-wide project access at a repeated prompt. That grant skips further confirmations and automatic review for this project/connection; revoke with /podman-access permissions. Never delegated.",
    promptGuidelines: ["Use this tool directly for authorized Podman work, including image builds blocked in Bash. It does not grant Podman access to Bash or cargo xtask. Specify each native Podman operation explicitly. Inspect effects before a retry. Commands can change the engine, publish images, send build contexts and affect host-mounted data: explain exact targets, mounts and network destinations. Do not pass secret values or display raw env/secret output. Prefer request_host_access podman_inspect for sanitized diagnostics. Never use containers or mounts to change Pi/Codex permissions, runtime or host credentials. A successful CLI exit does not prove application health."],
    async execute(id, input, signal, update, ctx) {
      const request = validateRequest(input);
      return tasks.run(async owned => {
        const cwd = realpathSync(ctx.cwd), home = realpathSync(homedir());
        const validate = () => {
          owned.throwIfAborted(); verify(ctx);
          if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD || realpathSync(ctx.cwd) !== cwd || !pi.getActiveTools().includes("request_podman_access")) throw new Error("Podman requires the interactive parent in the same workspace");
          outside(cwd, agentDir); outside(cwd, home);
          // Existing user configuration is protected from project writes, including symlink targets.
          for (const file of [join(home, ".config"), join(home, ".config/containers"), join(home, ".config/containers/podman-connections.json")]) {
            try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            outside(cwd, file);
          }
        };
        validate();
        const executable = serverIdentity(process.env.PI_PODMAN_BIN ?? "podman", [], cwd, { PATH: path });
        outside(cwd, executable.command);
        // Do not forward model/provider credentials, workspace env or connection overrides.
        const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
        Object.assign(env, { HOME: home, PATH: path, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(home, ".config"),
          CONTAINERS_CONF: "/dev/null", CONTAINERS_CONF_OVERRIDE: "/dev/null", CONTAINERS_STORAGE_CONF: "/dev/null" });
        let data: unknown;
        try { data = JSON.parse(await execute(executable.command, ["system", "connection", "list", "--format", "json"], { cwd: home, env, signal: owned, timeoutMs: 10000, maxBytes: 65536 })); }
        catch { throw new Error("Cannot read the configured Podman connections; no engine operation performed"); }
        if (!Array.isArray(data)) throw new Error("Invalid Podman connections");
        const defaults = data.filter(item => item && typeof item === "object" && item.Default === true);
        if (defaults.length !== 1) throw new Error("Configure exactly one default Podman connection first");
        const selected = defaults[0] as Record<string, unknown>;
        if (typeof selected.URI !== "string" || selected.URI.length > 2048) throw new Error("Invalid Podman endpoint");
        const url = new URL(selected.URI);
        if (url.password || url.search || url.hash || !url.pathname ||
            !(url.protocol === "unix:" && !url.host && !url.username || url.protocol === "ssh:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Podman bridge requires a local Unix socket or loopback SSH endpoint");
        const prefix = ["--url", selected.URI, "--ssh", "golang"];
        let key: string | undefined, keyIdentity: string | undefined;
        if (url.protocol === "ssh:") {
          if (typeof selected.Identity !== "string" || !isAbsolute(selected.Identity)) throw new Error("Podman SSH requires an explicit protected identity file");
          key = realpathSync(selected.Identity); outside(cwd, key);
          keyIdentity = sshIdentity(key); prefix.push("--identity", key);
        }
        const args = [...request.args];
        if (request.env_from_container) args.splice(args[0] === "container" ? 2 : 1, 0, "--unsetenv-all", "--env-file", "/dev/stdin", "--http-proxy=false");
        const argv = [...prefix, ...args], expires = Date.now() + 300000;
        const identity = fingerprint(executable), timeoutMs = (request.timeout_seconds ?? 300) * 1000;
        const title = "Autoriser une commande Podman ?";
        const transfer = request.env_from_container ? ` Lire Config.Env du conteneur ${request.env_from_container}, transmettre uniquement par stdin à create, puis lire Config.Env du conteneur créé pour vérifier l'égalité. Valeurs et sorties masquées; aucun démarrage, bascule ou nettoyage automatique.` : " Sorties affichées, secrets possibles.";
        const detail = `HORS SANDBOX, une fois, ${timeoutMs / 1000} s. Connexion locale fixée pour cet appel. Effets possibles sur moteur, montages hôte et registres; contexte de build envoyé au moteur.${transfer} Aucun droit Bash/sous-agent.\n${JSON.stringify({ executable: executable.command, cwd, argv, reason: request.reason })}`;
        const revalidate = () => {
          validate();
          if (Date.now() > expires) throw new Error("Podman approval expired");
          if (fingerprint(serverIdentity(executable.command, [], cwd, { PATH: path })) !== identity || key && sshIdentity(key) !== keyIdentity) throw new Error("Podman executable or SSH identity changed during approval");
        };
        const ticket = await approvals.authorize(ctx, {
          resource: "podman-access", auditOperation: request.args.slice(0, groups[request.args[0]] ? 2 : 1).join(" "), toolCallId: id,
          identity: fingerprint([identity, prefix, keyIdentity]), operation: fingerprint([cwd, argv, timeoutMs, request.env_from_container]), remember: false, interactiveOnly: true,
          projectAccess: {
            operation: "podman-engine-v1", label: PODMAN_PROJECT_CHOICE,
            detail: "Option permanente : toutes les opérations du pont sur ce moteur local, avec d'autres arguments, sans confirmation ni revue automatique. Inclut suppressions de conteneurs/volumes, publications et montages hôte ; ressources non limitées au projet. Liée au projet, à la connexion et au client affichés ci-dessus. Révocation : /podman-access permissions.",
          },
          title, detail, revalidate,
          beforePrompt(prompt, choices) {
            if (wrapTextWithAnsi(prompt, Math.max(20, (process.stdout.columns ?? 80) - 4)).length > Math.max(1, (process.stdout.rows ?? 24) - 6 - choices.length)) throw new Error("Podman approval does not fit the terminal; enlarge it or shorten the request");
          },
        }, owned);
        ticket();
        if (request.env_from_container) {
          let created: string | undefined, phase = "source environment read";
          const deadline = Date.now() + timeoutMs;
          const options = () => {
            ticket();
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("Podman deadline expired");
            return { cwd, env, signal: owned, timeoutMs: remaining, maxBytes: 1024 * 1024 };
          };
          try {
            const source = containerEnvironment(await execute(executable.command, [...prefix, "container", "inspect", "--format", "{{json .Config.Env}}", request.env_from_container], options()));
            phase = "create";
            const result = await execute(executable.command, argv, { ...options(), input: source.length ? source.join("\n") + "\n" : "" });
            if (!/^[a-f0-9]{64}\s*$/.test(result)) throw new Error("Invalid created container ID");
            created = result.trim(); phase = "environment verification";
            const actual = containerEnvironment(await execute(executable.command, [...prefix, "container", "inspect", "--format", "{{json .Config.Env}}", created], options()));
            if (JSON.stringify(actual) !== JSON.stringify(source)) throw new Error("Environment changed");
            return { content: [{ type: "text", text: `Created container ${created}. Environment matches source ${request.env_from_container}. Container not started; verify other runtime settings before activation.` }], details: { operation: "create", pending: false, containerId: created, environmentPreserved: true } };
          } catch {
            throw new Error(`Podman ${phase} failed or was canceled; secret-bearing output suppressed. ${created ? `Created container ${created} may remain.` : "Partial effects may remain."} Inspect before retrying; no automatic cleanup or activation performed.`);
          }
        }
        let output = "", lastUpdate = 0;
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-60000);
          if (Date.now() - lastUpdate >= 1000) {
            lastUpdate = Date.now(); update?.({ content: [{ type: "text", text: approvalDisplayText(output) }], details: { operation: request.args[0], pending: true } });
          }
        };
        try {
          await execute(executable.command, argv, { cwd, env, signal: owned, timeoutMs, maxBytes: 8 * 1024 * 1024, onStdout: collect, onStderr: collect });
          return { content: [{ type: "text", text: approvalDisplayText(output || "Podman exited successfully. Verify the requested effect separately.") }], details: { operation: request.args[0], pending: false } };
        } catch (error) {
          throw new Error(approvalDisplayText(`Podman failed or was canceled. Partial effects may remain; inspect before retrying.\n${error instanceof Error ? error.message : "Execution failed"}\n${output}`).slice(-64000));
        }
      }, signal);
    },
  });
}
