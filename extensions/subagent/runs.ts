import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

interface Owner {
  version: 1;
  parentSession: string;
  agent: string;
  agentFile: string;
  cwd: string;
  tools: string[];
  sessionId: string;
}

interface RunRequest {
  parentSession: string;
  agent: string;
  agentFile: string;
  cwd: string;
  tools: string[];
  resume?: string;
}

function readPrivateFile(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Invalid or oversized run file: ${file}`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let n; length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0;) length += n;
    if (length > stat.size) throw new Error(`Run file changed while reading: ${file}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

/** A native Pi session plus one exclusive invocation. No session replay or background scheduler. */
export function openRun(request: RunRequest) {
  if (!request.parentSession) throw new Error("A parent Pi session is required for delegation");
  const root = path.join(getAgentDir(), "subagent-runs");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Run storage must not be a symlink");
  if (request.resume && !/^run-[A-Za-z0-9]{6}$/.test(request.resume)) throw new Error("Invalid resume ID; use the returned run-XXXXXX ID, not a path");
  const dir = request.resume ? path.join(root, request.resume) : fs.mkdtempSync(path.join(root, "run-"));
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.join(fs.realpathSync(root), path.basename(dir))) {
    throw new Error("Run directory must be a real child of run storage");
  }
  const lockPath = path.join(dir, "active.lock");
  // ponytail: no stale-lock stealing; after a hard crash the user checks descendants before removing the lock.
  let lock: number;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This child is active or has a crash lock; inspect active.lock before retrying");
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  };
  try {
    fs.writeFileSync(lock, JSON.stringify({ supervisorPid: process.pid, started: new Date().toISOString() }));
    const cwd = fs.realpathSync(request.cwd);
    const agentFile = fs.realpathSync(request.agentFile);
    const sessionPath = path.join(dir, "session.jsonl");
    const ownerPath = path.join(dir, "owner.json");
    let owner: Owner;
    if (request.resume) {
      owner = JSON.parse(readPrivateFile(ownerPath, 64 * 1024));
      if (owner?.version !== 1 || owner.parentSession !== request.parentSession || owner.agent !== request.agent ||
          owner.agentFile !== agentFile || owner.cwd !== cwd || !Array.isArray(owner.tools) ||
          !owner.tools.every((name) => typeof name === "string") || typeof owner.sessionId !== "string") {
        throw new Error("Resume rejected: parent session, agent or working directory does not match");
      }
      const session = readPrivateFile(sessionPath, 64 * 1024 * 1024);
      if (!session.endsWith("\n")) throw new Error("Incomplete session tail; preserve the file and repair it before resuming");
      const entries = session.trimEnd().split("\n").map((line) => JSON.parse(line));
      const header = entries[0];
      if (header?.type !== "session" || header.version !== 3 || header.id !== owner.sessionId || header.cwd !== cwd) {
        throw new Error("Invalid native Pi session header; resume refused");
      }
    } else {
      // Pi initializes and owns the session format; opening the empty private file flushes its header.
      fs.writeFileSync(sessionPath, "", { flag: "wx", mode: 0o600 });
      const manager = SessionManager.open(sessionPath, dir, cwd);
      owner = { version: 1, parentSession: request.parentSession, agent: request.agent, agentFile, cwd,
        tools: [...request.tools], sessionId: manager.getSessionId() };
      fs.writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    }
    const tools = request.tools.filter((name) => owner.tools.includes(name));
    // Persist narrowing: a later invocation cannot restore a capability removed on resume.
    if (tools.length !== owner.tools.length) {
      const next = path.join(dir, "owner.next");
      fs.writeFileSync(next, JSON.stringify({ ...owner, tools }), { flag: "wx", mode: 0o600 });
      fs.renameSync(next, ownerPath);
    }
    const attemptDir = fs.mkdtempSync(path.join(dir, "attempt-"));
    return { id: path.basename(dir), sessionPath, tools, attemptDir, release };
  } catch (error) { release(); throw error; }
}
