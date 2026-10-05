import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { McpApprovals, approvalDisplayText, fingerprint, serverIdentity } from "../../lib/mcp-approvals.ts";
import { runProcess } from "../../lib/process.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import { classifyIncident } from "../notes/incidents.ts";

const parameters = Type.Object({
  operation: Type.Union([
    Type.Literal("podman_list"), Type.Literal("podman_inspect"), Type.Literal("podman_command"),
    Type.Literal("podman_logs"), Type.Literal("podman_machine_list"),
    Type.Literal("clipboard_env"), Type.Literal("clipboard_container_env"), Type.Literal("process_info"),
  ]),
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  args: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 64 })),
  file: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });
type Request = Static<typeof parameters>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host service response; raw output withheld");
  return value as Record<string, unknown>;
}

function environment(container: Record<string, unknown>): string[] {
  const env = record(container.Config ?? {}).Env ?? [];
  if (!Array.isArray(env) || !env.every(item => typeof item === "string" && item.includes("="))) throw new Error("Invalid container environment; output withheld");
  return env;
}

function selectedSecret(env: string[], key: string): string {
  const entries = env.filter(entry => entry.startsWith(`${key}=`));
  if (entries.length !== 1) throw new Error("Environment key missing or ambiguous; nothing copied");
  return entries[0].slice(key.length + 1);
}

function readProjectFile(file: string, cwd: string, limit: number): string {
  const canonical = realpathSync(file), rel = relative(cwd, canonical);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || canonical !== file) throw new Error("Source changed or lies outside the workspace");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Invalid or oversized source file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > limit) throw new Error("Source file exceeds its size limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/** Never return raw inspect/env data, command arguments, labels or health logs. */
export function publicContainer(value: unknown) {
  const item = record(value), env = environment(item);
  const origins: Record<string, string> = {}, flags: Record<string, boolean> = {};
  for (const entry of env) {
    const separator = entry.indexOf("="), key = entry.slice(0, separator), value = entry.slice(separator + 1);
    if (/^[A-Z][A-Z0-9_]*_PUBLIC_URL$/.test(key)) {
      try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol)) origins[key] = url.origin; } catch { /* Not a public origin; do not expose the value. */ }
    }
    if (/^[A-Z][A-Z0-9_]*_FALLBACK$/.test(key) && ["true", "false"].includes(value)) flags[key] = value === "true";
  }
  const ports: Record<string, { host: string; port: number }[]> = {};
  for (const [port, bindings] of Object.entries(record(record(item.NetworkSettings ?? {}).Ports ?? {}))) {
    if (!/^\d{1,5}\/(tcp|udp|sctp)$/.test(port) || !Array.isArray(bindings)) continue;
    ports[port] = bindings.map(value => {
      const binding = record(value), number = Number(binding.HostPort);
      return { host: typeof binding.HostIp === "string" && /^[\da-fA-F:.]+$/.test(binding.HostIp) ? binding.HostIp : "unknown", port: Number.isInteger(number) && number > 0 && number <= 65535 ? number : 0 };
    });
  }
  const status = record(item.State ?? {}).Status;
  return { id: typeof item.Id === "string" && /^[a-f0-9]{12,64}$/.test(item.Id) ? item.Id : "unknown", name: typeof item.Name === "string" && /^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(item.Name) ? item.Name : "unknown", status: typeof status === "string" && ["configured", "created", "initialized", "running", "stopped", "paused", "exited", "removing", "stopping", "unknown"].includes(status) ? status : "unknown", ports, publicOrigins: origins, fallbackFlags: flags, environmentKeys: env.map(entry => entry.slice(0, entry.indexOf("="))).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) };
}

/** Explicit host capabilities, not an unrestricted shell or a replay of failed Bash. */
export function registerHostAccess(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess) {
  const approvals = new McpApprovals(agentDir);
  let tasks = new SessionTasks();
  const reset = () => { approvals.reset(); const previous = tasks; tasks = new SessionTasks(); return previous.close(); };
  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_shutdown", reset);
  pi.registerCommand("host-access", {
    description: "/host-access reset: discard pending approvals and remembered refusals; grants never persist",
    handler: async (args, ctx) => {
      if (args.trim() !== "reset") return ctx.ui.notify("usage: /host-access reset", "info");
      await reset(); ctx.ui.notify("Pending host operations canceled and refusals cleared. Already performed effects remain.", "info");
    },
  });
  pi.registerTool({
    name: "request_host_access", label: "Request one host operation", exposure: "model-only", executionMode: "sequential",
    description: "Ask the human to run ONE host-side Podman, clipboard or process operation, outside Codex. No generic shell, background, remembered or delegated access. podman_list/inspect return limited diagnostics including public origins, never raw environment values. podman_logs reads at most tail (default 100, maximum 500) lines from the last hour of one container; logs may contain application secrets. podman_machine_list reports VM name/state/resources without connection credentials. clipboard_env copies one key from a project dotenv file; clipboard_container_env copies one container environment key without revealing its value. process_info returns PID/PPID/executable, not arguments or environment. podman_command accepts only start/stop/restart or kube play/down; output is withheld, verify effects separately. Clipboard is macOS-only. Each operation defaults to refusal.",
    promptGuidelines: ["After a relevant sandbox denial, request the specific host capability instead of repeating Bash or asking for another session. Never put secret values in arguments/reason. Clipboard transfer does not authorize login, form submission or sending a message. Podman can act beyond the workspace: explain the exact effect and preserve authentication/CSRF protections. Verify the configured Podman connection before requesting changes; it may be remote. Never use this bridge to alter Pi/Codex configuration or obtain an arbitrary host shell. The tool cannot approve itself."],
    parameters,
    async execute(_id, input, signal, _update, ctx) {
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized) > 2000) throw new Error("Host request exceeds 2000 bytes; shorten it for complete human review");
      const request = JSON.parse(serialized) as Request;
      const { reason, ...operation } = request;
      if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new Error("A bounded justification is required");
      const fields: Record<string, string[]> = {
        podman_list: [], podman_inspect: ["target"], podman_command: ["args"], podman_logs: ["target"], podman_machine_list: [],
        clipboard_env: ["file", "key"], clipboard_container_env: ["target", "key"], process_info: ["pid"],
      };
      const allowed = fields[request.operation];
      if (!allowed || Object.keys(operation).some(key => key !== "operation" && !allowed.includes(key) && !(request.operation === "podman_logs" && key === "tail")) || allowed.some(key => !(key in operation))) throw new Error("Invalid fields for host operation");
      if (request.tail !== undefined && (!Number.isSafeInteger(request.tail) || request.tail < 1 || request.tail > 500)) throw new Error("Log tail must be 1–500 lines");
      if (request.target !== undefined && (typeof request.target !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(request.target))) throw new Error("Expected one container name or ID, not flags");
      if (request.key !== undefined && (typeof request.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(request.key))) throw new Error("Invalid environment key");
      if (request.pid !== undefined && (!Number.isSafeInteger(request.pid) || request.pid <= 0)) throw new Error("Invalid process ID");
      if (request.operation.startsWith("clipboard_") && process.platform !== "darwin") throw new Error("Clipboard transfer requires macOS");
      return tasks.run(async owned => {
        const cwd = realpathSync(ctx.cwd);
        const validate = () => {
          owned.throwIfAborted(); verify(ctx);
          if (realpathSync(ctx.cwd) !== cwd || !ctx.hasUI || process.env.PI_SUBAGENT_CHILD || !pi.getActiveTools().includes("request_host_access")) throw new Error("Host access requires the interactive parent in the same workspace");
        };
        validate();
        // Capture trusted configuration; no workspace PATH entries are used for executable lookup.
        const env = { ...process.env }, path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
        const podman = request.operation.startsWith("podman_") || request.operation === "clipboard_container_env";
        const executable = serverIdentity(podman ? env.PI_PODMAN_BIN ?? "podman" : request.operation === "process_info" ? "/bin/ps" : "/usr/bin/pbcopy", [], cwd, { PATH: path });
        const executableRelative = relative(cwd, executable.command);
        if (!isAbsolute(executableRelative) && executableRelative !== ".." && !executableRelative.startsWith("../")) throw new Error("Host executable must be outside the writable workspace");
        let args: string[], secret: string | undefined, sourceIdentity: string | undefined, manifestIdentity: string | undefined;
        if (request.operation === "podman_list") args = ["ps", "--all", "--no-trunc", "--format", '{"id":{{json .ID}},"name":{{json .Names}},"ports":{{json .Ports}},"status":{{json .State}}}'];
        else if (request.operation === "podman_logs") args = ["logs", "--tail", String(request.tail ?? 100), "--since", "1h", "--timestamps", "--", request.target!];
        else if (request.operation === "podman_machine_list") args = ["machine", "list", "--format", "json"];
        else if (request.operation === "podman_inspect" || request.operation === "clipboard_container_env") args = ["container", "inspect", "--", request.target!];
        else if (request.operation === "podman_command") {
          args = request.args!;
          const lifecycle = args?.length === 2 && ["start", "stop", "restart"].includes(args[0]) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(args[1]);
          const kube = args?.[0] === "kube" && ["play", "down"].includes(args[1]) && (args.length === 3 || args.length === 4 && args[1] === "play" && args[2] === "--replace");
          if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || !arg || arg.length > 1024 || /[\u0000-\u001f]/.test(arg)) || !(lifecycle || kube)) throw new Error("Use [start|stop|restart, container] or [kube, play|down, optional --replace for play, project manifest]. No global flags, compose, machine SSH or shell");
          if (kube) {
            const manifest = realpathSync(resolve(cwd, args.at(-1)!)), rel = relative(cwd, manifest);
            if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Podman manifest must be inside this workspace");
            args[args.length - 1] = manifest;
            manifestIdentity = fingerprint(readProjectFile(manifest, cwd, 1024 * 1024));
          }
        } else if (request.operation === "process_info") args = ["-p", String(request.pid), "-o", "pid=,ppid=,comm="];
        else {
          if (typeof request.file !== "string" || request.file.length > 1024) throw new Error("Invalid dotenv path");
          const file = realpathSync(resolve(cwd, request.file)), rel = relative(cwd, file);
          if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Clipboard source must be a regular file inside this workspace");
          request.file = file;
          const raw = readProjectFile(file, cwd, 65536), values = parseEnv(raw);
          if (!Object.hasOwn(values, request.key!)) throw new Error("Environment key absent; nothing copied");
          secret = values[request.key!]; sourceIdentity = fingerprint(raw);
          args = [];
        }
        const identity = fingerprint([executable, env, sourceIdentity, manifestIdentity]), expires = Date.now() + 300_000;
        const revalidate = () => {
          validate();
          if (Date.now() > expires) throw new Error("Host approval request expired; no operation performed");
          if (wrapTextWithAnsi(visible, Math.max(20, (process.stdout.columns ?? 80) - 4)).length > Math.max(1, (process.stdout.rows ?? 24) - 8)) throw new Error("Approval does not fit the terminal; shorten the reason/arguments or enlarge the window. No operation performed.");
          if (fingerprint([serverIdentity(executable.command, [], cwd, { PATH: path }), env, sourceIdentity, manifestIdentity]) !== identity) throw new Error("Host executable changed during approval");
          if (sourceIdentity && fingerprint(readProjectFile(request.file!, cwd, 65536)) !== sourceIdentity) throw new Error("Clipboard source changed during approval");
          if (manifestIdentity && fingerprint(readProjectFile(args.at(-1)!, cwd, 1024 * 1024)) !== manifestIdentity) throw new Error("Podman manifest changed during approval");
        };
        const title = "Autoriser une opération sur l’hôte ?";
        const detail = `HORS SANDBOX, une fois, 60 s. Podman utilise votre connexion configurée, locale ou distante (non attestée), et peut agir hors projet. Aucun droit ajouté à Bash/sous-agents. Aucun login/envoi automatique.\n${request.operation.startsWith("clipboard_") ? "Secret hors transcript, mais presse-papiers partagé et historique possible.\n" : request.operation === "podman_logs" ? "Journaux affichés dans la conversation : secrets applicatifs possibles.\n" : ""}${JSON.stringify({ ...request, args: undefined, executable: executable.command, argv: args })}`;
        const visible = approvalDisplayText(`${title}\nProjet : ${JSON.stringify(cwd)}\n${detail}`);
        const ticket = await approvals.authorize(ctx, {
          resource: "host-access", identity, operation: fingerprint({ ...request, reason: undefined }), remember: false, interactiveOnly: true,
          title, detail, revalidate,
        }, owned);
        ticket();
        const options = { cwd, signal: AbortSignal.any([owned, AbortSignal.timeout(60_000)]), timeoutMs: 60_000, maxBytes: 1024 * 1024, env: { ...env, PATH: path, BASH_ENV: undefined, ENV: undefined } };
        try {
          if (request.operation === "clipboard_env") {
            if (!secret || secret.length > 8192) throw new Error("Invalid secret size");
            await execute(executable.command, args, { ...options, input: secret });
            return { content: [{ type: "text" as const, text: "Value copied to the host clipboard without displaying it. Its validity for any service has not been verified." }], details: { operation: request.operation } };
          }
          // Podman routes container stderr to CLI stderr even on successful logs.
          const logs: Buffer[] = [];
          const output = await execute(executable.command, args, request.operation === "podman_logs" ? {
            ...options, onStdout: (chunk: Buffer) => logs.push(chunk), onStderr: (chunk: Buffer) => logs.push(chunk),
          } : options);
          let text = output;
          if (request.operation === "podman_logs") text = approvalDisplayText(Buffer.concat(logs).toString("utf8"));
          if (request.operation === "podman_machine_list") {
            const data: unknown = JSON.parse(output);
            if (!Array.isArray(data) || data.length > 100) throw new Error("Invalid machine list");
            text = JSON.stringify(data.map(value => {
              const item = record(value);
              return { name: typeof item.Name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(item.Name) ? item.Name : "unknown",
                running: item.Running === true, cpus: Number.isSafeInteger(item.CPUs) ? item.CPUs : undefined,
                memory: /^(0|[1-9][0-9]{0,15})$/.test(String(item.Memory)) && Number.isSafeInteger(Number(item.Memory)) ? Number(item.Memory) : undefined };
            }));
          }
          if (request.operation === "podman_list") text = JSON.stringify(output ? output.split("\n").map(line => {
            const item = record(JSON.parse(line));
            const projected = publicContainer({ Id: item.id, Name: item.name, State: { Status: item.status } });
            return { id: projected.id, name: projected.name, status: projected.status, ports: typeof item.ports === "string" && /^[\da-fA-F:.,\[\]\s>/tcpuds-]*$/.test(item.ports) ? item.ports : "unknown" };
          }) : []);
          if (request.operation === "podman_command") text = "Podman command exited successfully. Output withheld to avoid exposing secrets. Verify the requested effect separately; this is not proof of application health.";
          if (["podman_inspect", "clipboard_container_env"].includes(request.operation)) {
            const data: unknown = JSON.parse(output);
            if (!Array.isArray(data) || data.length !== 1) throw new Error("Expected one inspected container");
            if (request.operation === "podman_inspect") text = JSON.stringify(publicContainer(data[0]));
            else {
              secret = selectedSecret(environment(record(data[0])), request.key!);
              if (!secret || secret.length > 8192) throw new Error("Invalid secret size");
              ticket();
              await execute("/usr/bin/pbcopy", [], { ...options, input: secret });
              text = "Selected container environment value copied to the host clipboard without displaying it. No login or form submitted.";
            }
          }
          return { content: [{ type: "text" as const, text: text.length > 60000 ? `${text.slice(0, 60000)}\n[Output truncated at 60000 characters]` : text }], details: { operation: request.operation } };
        } catch (error) {
          // CLI errors/inspect output can contain credentials. Return a fixed category, never raw payloads.
          const category = classifyIncident(error instanceof Error ? error.message : "")?.name ?? "host-operation";
          throw new Error(owned.aborted ? "Host operation canceled; no automatic retry. Effects already performed may remain." : `Host operation failed [${category}]; raw output withheld to protect secrets. No automatic retry. Check service availability/configuration and partial effects before requesting another operation.`);
        } finally { secret = undefined; }
      }, signal);
    },
  });
  pi.registerTool({
    name: "model_catalog", label: "Current model catalog",
    description: "Read the current Pi registry snapshot without starting another Pi, refreshing providers, resolving credentials or acquiring auth locks. Availability is cached configuration, not a successful quota/auth probe. No model call or automatic switch.",
    parameters: Type.Object({ provider: Type.Optional(Type.String()), availableOnly: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted(); verify(ctx);
      const available = new Set(ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`));
      const models = ctx.modelRegistry.getAll().filter(model => (!input.provider || model.provider === input.provider) && (input.availableOnly === false || available.has(`${model.provider}/${model.id}`)));
      const result = { total: models.length, models: models.slice(0, input.limit ?? 200).map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, available: available.has(`${model.provider}/${model.id}`) })), availability: "cached, not remotely verified" };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  });
}
