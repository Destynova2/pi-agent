import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Scope = "once" | "session" | "project" | "policy";
type Source = "human" | "session" | "project" | "policy" | "refusal_cache" | "unavailable";
type Decision = "allow" | "deny" | "cancel";
type Status = "granted" | "denied" | "cancelled" | "error";
type Context = Pick<ExtensionContext, "cwd" | "hasUI"> & Partial<Pick<ExtensionContext, "sessionManager">>;

/** The payload is fingerprinted, never stored: commands, arguments and errors can contain secrets. */
interface Request {
  resource: string;
  operation: string;
  payload?: unknown;
  toolCallId?: string;
  targets?: string[];
}

function checkPrivate(path: string, directory = false) {
  const stat = lstatSync(path);
  // A sidecar unlinked concurrently by SQLite can have zero links in lstat.
  // It exposes no other path; only extra hard links make this storage unsafe.
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) ||
      (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Unsafe permission audit storage");
  }
}

function openDatabase(agentDir: string, cwd: string): DatabaseSync {
  const agent = realpathSync(agentDir), rel = relative(cwd, agent);
  if (!rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) {
    throw new Error("Permission audit must live outside the writable workspace");
  }
  const directory = join(agent, "permission-audit");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  checkPrivate(directory, true);
  const path = join(directory, "requests.sqlite");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Unsafe permission audit storage");
    }
  } finally { closeSync(fd); }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { checkPrivate(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const deadline = performance.now() + 5000;
    // Changing journal mode can return SQLITE_BUSY without invoking busy_timeout.
    // Concurrent first requests must wait for that short initialization lock.
    for (;;) {
      try { db.exec("PRAGMA journal_mode = WAL;"); break; }
      catch (error) {
        if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5 || performance.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    db.exec("PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported permission audit schema");
    if (version === 0) db.exec(`
      CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        prompted_at TEXT,
        answered_at TEXT,
        completed_at TEXT,
        session_id TEXT,
        session_file TEXT,
        tool_call_id TEXT,
        cwd TEXT NOT NULL,
        pid INTEGER NOT NULL,
        resource TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        targets_json TEXT NOT NULL,
        interactive INTEGER NOT NULL CHECK (interactive IN (0, 1)),
        decision TEXT CHECK (decision IN ('allow', 'deny', 'cancel')),
        scope TEXT CHECK (scope IN ('once', 'session', 'project', 'policy')),
        source TEXT CHECK (source IN ('human', 'session', 'project', 'policy', 'refusal_cache', 'unavailable')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'denied', 'cancelled', 'error'))
      );
      CREATE INDEX IF NOT EXISTS permission_requests_time ON permission_requests(requested_at);
      CREATE INDEX IF NOT EXISTS permission_requests_session ON permission_requests(session_id, requested_at);
      PRAGMA user_version = 1;
    `);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Synchronous durable writes; no connection or transaction stays open across a human prompt. */
export class PermissionAudit {
  private readonly agentDir: string;
  private readonly cwd: string;
  private readonly id = randomUUID();
  private finished = false;
  private decision: Decision | undefined;

  constructor(agentDir: string, ctx: Context, request: Request) {
    this.agentDir = realpathSync(agentDir);
    this.cwd = realpathSync(ctx.cwd);
    const db = openDatabase(this.agentDir, this.cwd);
    try {
      db.prepare(`INSERT INTO permission_requests
        (id, requested_at, session_id, session_file, tool_call_id, cwd, pid, resource, operation, request_sha256, targets_json, interactive)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.id, new Date().toISOString(), ctx.sessionManager?.getSessionId() ?? null,
        ctx.sessionManager?.getSessionFile() ?? null, request.toolCallId ?? null, this.cwd, process.pid,
        request.resource, request.operation,
        createHash("sha256").update(JSON.stringify(request.payload ?? null)).digest("hex"),
        JSON.stringify(request.targets ?? []), Number(ctx.hasUI),
      );
    } finally { db.close(); }
  }

  prompted() {
    this.update("prompted_at = ?, source = 'human'", [new Date().toISOString()]);
  }

  answered(decision: Decision, scope: Scope = "once") {
    this.update("answered_at = ?, decision = ?, scope = ?, source = 'human'", [new Date().toISOString(), decision, scope]);
    this.decision = decision;
  }

  finish(status: Status, source?: Source, scope?: Scope) {
    if (this.finished) return;
    this.update("completed_at = ?, status = ?, source = COALESCE(?, source), scope = COALESCE(?, scope)",
      [new Date().toISOString(), status, source ?? null, scope ?? null]);
    this.finished = true;
  }

  fail(signal?: AbortSignal) {
    this.finish(signal?.aborted || this.decision === "cancel" ? "cancelled" : this.decision === "deny" ? "denied" : "error");
  }

  private update(set: string, values: (string | null)[]) {
    const db = openDatabase(this.agentDir, this.cwd);
    try {
      const result = db.prepare(`UPDATE permission_requests SET ${set} WHERE id = ? AND status = 'pending'`).run(...values, this.id);
      if (result.changes !== 1) throw new Error("Permission audit request missing or already completed");
    } finally { db.close(); }
  }
}
