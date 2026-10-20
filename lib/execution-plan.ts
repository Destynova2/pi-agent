import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { commandWritableRoots, executionProfile, executionBinding, executionReadOnlyRoots, sandboxBackend } from "../scripts/codex-shell.mjs";
import { readNetworkPolicy } from "../scripts/codex-network.mjs";
import { isolatedArgs, isolatedRuntime, snapshotCommand } from "./isolated-command.ts";
import { privateIpcSeccomp } from "./private-ipc-seccomp.mjs";
import { runtimeRoot } from "./runtime-paths.mjs";

export class ExecutionError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`[${code}] ${message}`); this.code = code; }
}
export interface ExecutionRequest {
  command: string; reason: string; cwd?: string;
  profile?: "workspace" | "isolated"; write_paths?: string[]; hosts?: string[];
  inputs?: string[]; binaries?: string[]; timeout_ms?: number; background?: boolean;
}
const protectedNames = new Set([".git", ".jj", ".pi", ".codex", ".agents", ".ssh", ".aws", ".kube"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (path: string, content = false): unknown => {
  if (!existsSync(path)) return [path, "absent", identity(dirname(path))];
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new ExecutionError("stale_request", "A resource became a symlink");
  return [path, stat.dev, stat.ino, stat.mode, ...(content ? [stat.size, stat.mtimeMs, stat.ctimeMs] : [])];
};
export function executionCapabilities(platform = process.platform) {
  return { version: 1, profiles: {
    workspace: { supported: platform === "linux", filesystem: "workspace plus exact extra write paths; baseline host reads", network: "exact public DNS names, any port, proxy enforced; empty hosts means offline", privateIPC: false },
    isolated: { supported: platform === "linux", filesystem: "explicit immutable input copies; disposable outputs", network: "none", privateIPC: true },
  }, lifetimes: platform === "linux" ? ["foreground", "session"] : [], timeoutMs: { min: 1000, max: 120000 }, maxConcurrent: 4, workspaceConcurrency: "one per agent installation, exclusive native lock",
  unsupported: ["leased services", "devices", "host sockets", "private networking", "host listeners", "isolated network or host writes", "unqualified macOS generic execution"],
  note: "Support describes adapters, not host availability. Every run is preflighted and reviewed; no failure or human dialog is required. Git metadata uses git_access." };
}

/** Deterministic preparation. No model verdict changes resource normalization or adapter selection. */
export function prepareExecution(input: ExecutionRequest, sessionCwd: string, agentDir: string,
  dependencies = { platform: process.platform, runtime: isolatedRuntime, snapshot: snapshotCommand, backend: sandboxBackend }) {
  const request = structuredClone(input);
  const keys = new Set(["command", "reason", "cwd", "profile", "write_paths", "hosts", "inputs", "binaries", "timeout_ms", "background"]);
  if (Object.keys(request).some(key => !keys.has(key))) throw new ExecutionError("backend_unsupported", "Unknown execution resource; query capabilities");
  if (typeof request.command !== "string" || !request.command.trim() || request.command.length > 8000 || request.command.includes("\0") ||
      typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1000) throw new ExecutionError("invalid_request", "Expected bounded command and reason");
  const timeoutMs = request.timeout_ms ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000 || request.background !== undefined && typeof request.background !== "boolean") throw new ExecutionError("invalid_request", "Invalid execution lifetime");
  if (request.background && dependencies.platform !== "linux") throw new ExecutionError("backend_unsupported", "Session jobs require qualified Linux descendant containment");
  const profile = request.profile ?? "workspace";
  if (!["workspace", "isolated"].includes(profile) || !executionCapabilities(dependencies.platform).profiles[profile].supported) throw new ExecutionError("backend_unsupported", "Execution profile unavailable on this platform");
  sessionCwd = realpathSync(sessionCwd);
  const selected = request.cwd ?? sessionCwd;
  if (!isAbsolute(selected) || resolve(selected) !== selected || realpathSync(selected) !== selected || selected.split("/").some(part => protectedNames.has(part))) throw new ExecutionError("invalid_request", "Expected a canonical project cwd outside protected storage");
  const cwd = selected;
  if (!lstatSync(cwd).isDirectory()) throw new ExecutionError("invalid_request", "Execution cwd must be a directory");
  if (cwd !== sessionCwd) {
    if (cwd.startsWith(`${sessionCwd}/`)) throw new ExecutionError("invalid_request", "Use a command-local cd for workspace subdirectories; keep the workspace boundary fixed");
    commandWritableRoots([cwd], sessionCwd, agentDir);
  }
  const resources = executionProfile({ hosts: request.hosts ?? [], writePaths: request.write_paths ?? [] });
  const scope = { command: request.command, cwd, profile, reason: request.reason, timeoutMs, lifetime: request.background ? "session" : "foreground" };
  if (profile === "isolated") {
    if (resources.hosts.length || resources.writePaths.length) throw new ExecutionError("backend_unsupported", "Private IPC adapter is offline with disposable writes; cannot add network or host writes");
    const runtime = dependencies.runtime(), filter = privateIpcSeccomp();
    const snapshot = dependencies.snapshot(cwd, agentDir, request.inputs ?? [], request.binaries ?? []);
    try {
      const args = isolatedArgs(snapshot, request.command, runtime);
      return { summary: { ...scope, snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes, inputs: snapshot.inputs, binaries: snapshot.binaries }, capabilities: executionCapabilities(dependencies.platform).profiles.isolated },
        validate() {}, dispose: snapshot.dispose,
        launch: () => ({ program: runtime.backend, args, options: { cwd: snapshot.directory, input: Readable.from([filter]), timeoutMs } }) };
    } catch (error) { snapshot.dispose(); throw error; }
  }
  if (request.inputs !== undefined || request.binaries !== undefined) throw new ExecutionError("invalid_request", "Input copies and imported binaries require the isolated profile");
  if (dependencies.platform === process.platform && !existsSync("/usr/bin/flock")) throw new ExecutionError("backend_unsupported", "Workspace execution requires /usr/bin/flock");
  const backend = realpathSync(dependencies.backend());
  const roots = resources.writePaths.length ? commandWritableRoots(resources.writePaths, cwd, agentDir, [backend]) : [];
  // Other repositories' metadata stays read-only even when their ordinary files are writable.
  for (const path of roots) if (path.split("/").some(part => protectedNames.has(part))) throw new ExecutionError("policy_denied", "Protected write path");
  if (roots.some(path => !existsSync(path))) throw new ExecutionError("invalid_request", "Extra write roots must already exist before review");
  const binding = executionBinding(cwd, roots);
  const launchProfile = JSON.stringify({ hosts: resources.hosts, writePaths: roots, binding });
  if (Buffer.byteLength(launchProfile) > 16384) throw new ExecutionError("resource_limit", "Execution profile exceeds 16 KiB before review");
  const protectedPaths = executionReadOnlyRoots([cwd, ...roots]);
  const policy = readNetworkPolicy(agentDir);
  if (resources.hosts.some(host => policy.deny.includes(host))) throw new ExecutionError("policy_denied", "A requested host is explicitly denied");
  const policyHash = digest(policy), cwdIdentity = digest(identity(cwd)), backendIdentity = digest(identity(backend, true)), rootsIdentity = digest(roots.map(path => identity(path)));
  const launcher = join(runtimeRoot, "scripts/codex-shell.mjs");
  const validate = () => {
    if (policyHash !== digest(readNetworkPolicy(agentDir)) || cwdIdentity !== digest(identity(cwd)) || backendIdentity !== digest(identity(backend, true)) || rootsIdentity !== digest(roots.map(path => identity(path))) || realpathSync(dependencies.backend()) !== backend) throw new ExecutionError("stale_request", "Execution resources or network policy changed during review");
    if (digest(executionReadOnlyRoots([cwd, ...roots])) !== digest(protectedPaths)) throw new ExecutionError("stale_request", "Write-root metadata changed during review");
    if (roots.length && JSON.stringify(commandWritableRoots(roots, cwd, agentDir, [backend])) !== JSON.stringify(roots)) throw new ExecutionError("stale_request", "Write paths changed during review");
  };
  return { summary: { ...scope, hosts: resources.hosts, writePaths: roots, writableWorkspace: cwd, protectedPaths, backend, capabilities: executionCapabilities(dependencies.platform).profiles.workspace, inputMode: "live workspace; resource boundary applies to all descendant code" },
    validate, dispose() {}, launch: () => ({ program: "/usr/bin/flock", args: ["--exclusive", "--nonblock", "--conflict-exit-code", "75", join(agentDir, "execution.lock"), launcher, "--execution-profile", launchProfile, "-c", request.command],
      options: { cwd, timeoutMs, env: { PI_CODING_AGENT_DIR: agentDir, PI_CODEX_SANDBOX_BIN: backend } } }) };
}
