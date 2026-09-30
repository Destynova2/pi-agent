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

export function networkSandboxArgs(command, cwd, scratch, allowedHosts) {
  const allowed = hosts(allowedHosts);
  const q = JSON.stringify;
  const domains = allowed.map(host => `${q(host)}="allow"`).join(",");
  // Inherit Codex's protected metadata roots, but not its shared system-temp write grants.
  const filesystem = `filesystem={":slash_tmp"="read",${q(scratch)}="write",":workspace_roots"={".pi"="read"}}`;
  const network = `network={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,allow_local_binding=false,dangerously_allow_non_loopback_proxy=false,dangerously_allow_all_unix_sockets=false,mode="full",domains={${domains}}}`;
  return ["sandbox", "-C", cwd, "-P", "pi", "--include-managed-config",
    "-c", 'features.network_proxy=true',
    "-c", `permissions={pi={extends=":workspace",${filesystem},${network}}}`,
    "--", "/bin/bash", "--noprofile", "--norc", "-c", command];
}
