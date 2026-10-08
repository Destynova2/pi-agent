import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fingerprint, serverIdentity } from "./mcp-approvals.ts";
import { runProcess } from "./process.ts";

const path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

function outside(cwd: string, file: string) {
  const rel = relative(cwd, realpathSync(file));
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))) throw new Error("Podman runtime/configuration must be outside the writable workspace");
}

function sshIdentity(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error("Unsafe Podman SSH identity file");
  return fingerprint({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
}

/** Fixed local endpoint, protected executable/key and a credential-free client environment. */
export async function localPodman(cwd: string, agentDir: string, signal?: AbortSignal, execute = runProcess) {
  const home = realpathSync(homedir());
  const validatePaths = () => {
    outside(cwd, agentDir); outside(cwd, home);
    for (const file of [join(home, ".config"), join(home, ".config/containers"), join(home, ".config/containers/podman-connections.json")]) {
      try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      outside(cwd, file);
    }
  };
  signal?.throwIfAborted();
  validatePaths();
  const executable = serverIdentity(process.env.PI_PODMAN_BIN ?? "podman", [], cwd, { PATH: path });
  outside(cwd, executable.command);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { HOME: home, PATH: path, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(home, ".config"),
    CONTAINERS_CONF: "/dev/null", CONTAINERS_CONF_OVERRIDE: "/dev/null", CONTAINERS_STORAGE_CONF: "/dev/null" });
  let data: unknown;
  try { data = JSON.parse(await execute(executable.command, ["system", "connection", "list", "--format", "json"], { cwd: home, env, signal, timeoutMs: 10000, maxBytes: 65536 })); }
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
  const executableIdentity = fingerprint(executable);
  return {
    executable, env, prefix, identity: fingerprint([executableIdentity, prefix, keyIdentity]),
    verify() {
      validatePaths();
      if (fingerprint(serverIdentity(executable.command, [], cwd, { PATH: path })) !== executableIdentity || key && sshIdentity(key) !== keyIdentity) throw new Error("Podman executable or SSH identity changed during approval");
    },
  };
}
