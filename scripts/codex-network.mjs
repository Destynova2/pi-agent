// Shared by the trusted shell launcher and Pi's network-approval tool.
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { domainToASCII } from "node:url";

export const DEFAULT_NETWORK_HOSTS = Object.freeze([
  "github.com", "api.github.com", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "codeload.github.com", "registry.npmjs.org",
]);

export function normalizeHost(value) {
  if (typeof value !== "string" || value.length > 253 || /[\s/:@*?#\\]/.test(value)) throw new Error("Expected an exact public hostname, not a URL, IP, port or wildcard");
  const host = domainToASCII(value).toLowerCase();
  if (!host || host.length > 253 || isIP(host) || !host.includes(".") || /\.(localhost|local|internal|invalid|test)$/.test(host)
    || host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/[a-z]/.test(host.split(".").at(-1))) {
    throw new Error("Expected an exact public DNS hostname");
  }
  return host;
}

/** Public web reads use default ports, no credentials and no fragment on the wire. */
export function publicWebUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error("Expected a public HTTP(S) URL without credentials or control characters");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error("Expected a public HTTP(S) URL on its default port without credentials");
  normalizeHost(url.hostname); // The managed proxy also blocks private DNS resolutions.
  url.hash = "";
  return url.href;
}

function hosts(value) {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Expected at most 128 network hosts");
  return [...new Set(value.map(normalizeHost))].sort();
}

function readJson(path, optional = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Network policy must be a regular file smaller than 64 KiB");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readNetworkPolicy(agentDir) {
  const policy = readJson(join(agentDir, "network-policy.json"), true);
  if (policy === undefined) return { allow: [...DEFAULT_NETWORK_HOSTS], deny: [] };
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => !["allow", "deny"].includes(key))) throw new Error("Invalid network-policy.json; expected allow and optional deny arrays");
  return { allow: hosts(policy.allow), deny: hosts(policy.deny ?? []) };
}

export function networkHosts(agentDir, cwd, grantPath) {
  const policy = readNetworkPolicy(agentDir);
  let granted = [];
  if (grantPath) {
    const directory = join(realpathSync(agentDir), "network-grants");
    // Only the host broker writes here; sandbox children cannot forge these files.
    if (realpathSync(dirname(grantPath)) !== directory) throw new Error("Network grant is outside the trusted grant directory");
    const grant = readJson(grantPath);
    if (!grant || grant.cwd !== realpathSync(cwd)) throw new Error("Network grant belongs to a different workspace");
    granted = hosts(grant.hosts);
  }
  return hosts([...new Set([...policy.allow, ...granted])].filter(host => !policy.deny.includes(host)));
}

export function requireNetworkProxyVersion(output) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 155 || (Number(match[2]) === 155 && Number(match[3]) < 1)))) {
    throw new Error("Managed network sandbox requires stable Codex >=0.155.1; refusing an unverified proxy backend");
  }
}

export function sandboxFilesystem(scratch, writableRoots = [], readOnlyRoots = []) {
  const q = JSON.stringify;
  // Inherit Codex's protected metadata roots, but not its shared system-temp write grants.
  const additional = writableRoots.map(path => `,${q(path)}="write"`).join("");
  const protectedPaths = readOnlyRoots.map(path => `,${q(path)}="read"`).join("");
  return `filesystem={":slash_tmp"="read",${q(scratch)}="write",":workspace_roots"={".pi"="read"}${additional}${protectedPaths}}`;
}

export function confinedCommand(command) {
  // This handoff marker is set by env INSIDE Codex, after OS confinement succeeds.
  // It prevents accidental direct worker launches; the OS policy enforces permissions.
  // CODEX_SANDBOX is not supplied by the Linux CLI and is not a portable contract.
  return ["--", "/usr/bin/env", "PI_CONFINED=1", "/bin/bash", "--noprofile", "--norc", "-c", command];
}

export function networkSandboxArgs(command, cwd, scratch, allowedHosts, writableRoots = [], readOnlyRoots = [], privateHost) {
  const allowed = hosts(allowedHosts);
  // This exception belongs to a reviewed Git operation, never a baseline/session grant.
  if (privateHost !== undefined && (allowed.length !== 1 || allowed[0] !== normalizeHost(privateHost))) throw new Error("Private Git networking requires exactly its reviewed host");
  // On macOS allow_local_binding also opens direct host-loopback sockets and
  // DNS, outside the proxy's domain filter. Linux retains a private namespace.
  if (privateHost !== undefined && process.platform !== "linux") throw new Error("PRIVATE_GIT_NETWORK_UNAVAILABLE: private Git access requires Linux network isolation; this platform cannot confine it to the reviewed host. No command executed; no unconfined fallback.");
  const domains = allowed.map(host => `${JSON.stringify(host)}="allow"`).join(",");
  const filesystem = sandboxFilesystem(scratch, writableRoots, readOnlyRoots);
  const network = `network={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,allow_local_binding=${privateHost !== undefined},dangerously_allow_non_loopback_proxy=false,dangerously_allow_all_unix_sockets=false,mode="full",domains={${domains}}}`;
  return ["sandbox", "-C", cwd, "-P", "pi", "--include-managed-config",
    "-c", 'features.network_proxy=true',
    "-c", `permissions={pi={extends=":workspace",${filesystem},${network}}}`,
    ...confinedCommand(command)];
}
