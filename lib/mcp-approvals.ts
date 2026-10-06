import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { PermissionAudit } from "./permission-audit.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const APPROVAL_CHOICES = ["Refuser", "Autoriser cette fois", "Autoriser pour cette session", "Toujours autoriser pour ce projet"];
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]));
})).digest("hex");
export const approvalDisplayText = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Bind the configured invocation and resolved executable, not mutable data-file arguments.
// This does not attest script contents/dependencies or prove a server's read-only claims.
export function serverIdentity(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const candidates = command.includes("/") ? [resolve(cwd, command)] : (env.PATH ?? process.env.PATH ?? "").split(delimiter).map(dir => resolve(cwd, dir, command));
  const executable = candidates.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
  if (!executable) throw new Error(`MCP executable not found: ${command}`);
  const commandPath = realpathSync(executable), stat = statSync(commandPath);
  return {
    command: commandPath, args, path: env.PATH ?? process.env.PATH,
    executable: { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs },
  };
}

interface Approval {
  resource: string;
  auditOperation?: string;
  toolCallId?: string;
  identity: string;
  operation: string;
  title: string;
  detail: string;
  remember: boolean;
  interactiveOnly?: boolean;
  revalidate: () => void;
}

function readPrivate(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe MCP approval file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function atomic(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, value, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

/** Host-owned consent only: never changes the OS sandbox or the server's own approval state. */
export class McpApprovals {
  private readonly agentDir: string;
  private generation = 0;
  private readonly session = new Map<string, string>();
  private readonly refused = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(agentDir: string) { this.agentDir = realpathSync(agentDir); }
  reset() { this.generation++; this.session.clear(); this.refused.clear(); }

  private directory(cwd: string, resource: string, create = false): string | undefined {
    const rel = relative(cwd, this.agentDir);
    if (!rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) throw new Error("MCP approvals must live outside the writable workspace");
    let path = this.agentDir;
    for (const part of ["mcp-approvals", fingerprint(cwd), fingerprint(resource)]) {
      path = join(path, part);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return undefined;
        mkdirSync(path, { mode: 0o700 }); stat = lstatSync(path);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe MCP approval directory");
    }
    return path;
  }

  private epoch(cwd: string, resource: string): string {
    const directory = this.directory(cwd, resource);
    if (!directory) return "initial";
    const epoch = readPrivate(join(directory, "epoch"));
    if (epoch !== undefined && !/^[a-f0-9-]{36}$/.test(epoch)) throw new Error("Invalid MCP revocation epoch");
    return epoch ?? "initial";
  }

  private saved(cwd: string, resource: string, key: string, epoch: string): boolean {
    const directory = this.directory(cwd, resource);
    if (!directory) return false;
    const raw = readPrivate(join(directory, `${key}.json`));
    if (raw === undefined) return false;
    const data = JSON.parse(raw) as { version?: unknown; epoch?: unknown; key?: unknown };
    if (!data || data.version !== 1 || typeof data.epoch !== "string" || data.key !== key) throw new Error("Invalid MCP approval");
    return data.epoch === epoch;
  }

  revoke(cwd: string, resource: string) {
    const directory = this.directory(realpathSync(cwd), resource, true)!;
    // Separate epoch prevents a late writer in another process from restoring a revoked grant.
    atomic(join(directory, "epoch"), randomUUID());
    this.reset();
    for (const name of readdirSync(directory)) if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(join(directory, name), { force: true });
  }

  async authorize(ctx: ExtensionContext, input: Approval, signal?: AbortSignal): Promise<() => void> {
    const audit = new PermissionAudit(this.agentDir, ctx, {
      resource: input.resource, operation: input.auditOperation ?? "authorize", toolCallId: input.toolCallId, payload: input,
    });
    try {
      const request = { ...input }, cwd = realpathSync(ctx.cwd), generation = this.generation;
      const epoch = this.epoch(cwd, request.resource);
      const key = fingerprint([cwd, request.resource, request.identity, request.operation]);
      const run = async () => {
        let scope: "once" | "session" | "project" = "once";
        let source: "human" | "session" | "project" = "human";
        const check = () => {
          signal?.throwIfAborted();
          if (generation !== this.generation || cwd !== realpathSync(ctx.cwd) || epoch !== this.epoch(cwd, request.resource)) throw new Error("MCP approval became stale or was revoked");
          request.revalidate();
          if (scope === "session" && this.session.get(key) !== epoch) throw new Error("MCP session approval revoked");
          if (scope === "project" && !this.saved(cwd, request.resource, key, epoch)) throw new Error("MCP project approval revoked");
        };
        check();
        if (request.interactiveOnly && !ctx.hasUI) { audit.finish("denied", "unavailable"); throw new Error("Dunst requires an interactive parent session, including remembered approvals"); }
        if (this.refused.has(key)) { audit.finish("denied", "refusal_cache"); throw new Error(`Operation refused earlier; use ${request.resource === "host-access" ? "/host-access reset" : "the permissions command"} to reconsider`); }
        if (request.remember && this.session.get(key) === epoch) { scope = "session"; source = "session"; }
        else if (request.remember && this.saved(cwd, request.resource, key, epoch)) { scope = "project"; source = "project"; }
        else {
          if (!ctx.hasUI) { audit.finish("denied", "unavailable"); throw new Error("MCP access requires human approval; no matching project grant"); }
          const title = approvalDisplayText(request.title).replaceAll("\n", "\\n").replaceAll("\t", "\\t");
          const detail = approvalDisplayText(`Projet : ${JSON.stringify(cwd)}\n${request.detail}`);
          const choices = request.remember ? [...APPROVAL_CHOICES] : APPROVAL_CHOICES.slice(0, 2);
          audit.prompted();
          const choice = await ctx.ui.select(`${title}\n${detail}`, choices, { signal });
          audit.answered(!choice ? "cancel" : choice === APPROVAL_CHOICES[0] || !choices.includes(choice) ? "deny" : "allow",
            choice === APPROVAL_CHOICES[3] ? "project" : choice === APPROVAL_CHOICES[2] ? "session" : "once");
          check();
          if (!choice || choice === APPROVAL_CHOICES[0] || !choices.includes(choice)) {
            this.refused.add(key); throw new Error("Operation not approved");
          }
          if (choice === APPROVAL_CHOICES[2]) { this.session.set(key, epoch); scope = "session"; }
          else if (choice === APPROVAL_CHOICES[3]) {
            const directory = this.directory(cwd, request.resource, true)!;
            if (readdirSync(directory).length >= 1024) throw new Error("Too many MCP grants; revoke old permissions first");
            atomic(join(directory, `${key}.json`), JSON.stringify({ version: 1, epoch, key }));
            scope = "project";
          }
        }
        check();
        audit.finish("granted", source, scope);
        return check;
      };
      const result = this.tail.then(run, run);
      this.tail = result.catch(() => undefined);
      return await result;
    } catch (error) { audit.fail(signal); throw error; }
  }
}
