import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { runProcess } from "./process.ts";

// Only the fixed search worker receives these hosts, never Bash or a session grant.
export const CLAUDE_SEARCH_HOSTS = ["api.anthropic.com", "claude.ai"];

export function claudeSearchBinary(cwd: string): string {
  const project = realpathSync(cwd);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", "claude");
    try { accessSync(candidate, constants.X_OK); } catch { continue; }
    const binary = realpathSync(candidate), rel = relative(project, binary);
    if (!rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error("WEB_SEARCH_UNTRUSTED_BINARY: Claude must be installed outside the writable project");
    return binary;
  }
  throw new Error("WEB_SEARCH_UNAVAILABLE: Claude Code executable not found");
}

/** Read only the default Claude login, on the trusted parent. Never return a refresh token. */
export async function claudeSearchToken(agentDir: string, signal?: AbortSignal, execute = runProcess): Promise<string | undefined> {
  if (process.platform !== "darwin" || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return undefined;
  let fd: number;
  try { fd = openSync(join(agentDir, "web-search.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error("Unsafe web-search.json");
    const config: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).join() !== "keychainBridge" ||
        !("keychainBridge" in config) || typeof config.keychainBridge !== "boolean") throw new Error("Invalid web-search.json; expected keychainBridge boolean");
    if (!config.keychainBridge) return undefined;
  } finally { closeSync(fd); }
  const chunks: Buffer[] = [];
  try {
    await execute("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      cwd: "/", signal, timeoutMs: 5000, maxBytes: 64 * 1024, onStdout: chunk => chunks.push(chunk),
    });
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!raw || typeof raw !== "object" || !("claudeAiOauth" in raw)) throw new Error("Invalid credential record");
    const login = raw.claudeAiOauth;
    if (!login || typeof login !== "object" || !("accessToken" in login) || !("expiresAt" in login)) throw new Error("Invalid login");
    if (typeof login.accessToken !== "string" || login.accessToken.length < 16 || login.accessToken.length > 16384 ||
        /[\u0000-\u0020\u007f]/.test(login.accessToken)) throw new Error("Invalid access token");
    if (typeof login.expiresAt !== "number" || !Number.isFinite(login.expiresAt) || login.expiresAt <= Date.now() + 125_000) {
      throw new Error("WEB_SEARCH_AUTH_EXPIRED: refresh the Claude Code login in its native terminal, then retry the search");
    }
    return login.accessToken;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("WEB_SEARCH_AUTH_EXPIRED:")) throw error;
    // Neither keychain output nor error text may escape to a tool result or audit.
    throw new Error("WEB_SEARCH_AUTH_UNAVAILABLE: the default Claude Code login could not be read from macOS Keychain. Check claude auth status in a host terminal; no credential was exported or saved");
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
