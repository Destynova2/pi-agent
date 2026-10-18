import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.ts";
import { CLAUDE_SEARCH_HOSTS, claudeSearchBinary, claudeSearchToken } from "./claude-search.ts";
import { readNetworkPolicy } from "../scripts/codex-network.mjs";

/** The launcher selects a fixed GET worker; no command or session network grant. */
export async function runUserWebRead(cwd: string, url: string, signal?: AbortSignal): Promise<string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  return JSON.parse(await runProcess(join(root, "scripts/codex-shell.mjs"), ["--web-url", url], {
    cwd, signal, timeoutMs: 40_000, maxBytes: 8 * 1024 * 1024,
  }));
}

/** Fixed worker programs only; model arguments cross stdin, never the shell command. */
export async function runConfined(cwd: string, service: "notes" | "graphify" | "git" | "web" | "ci" | "search", input: unknown, signal?: AbortSignal): Promise<unknown> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (service === "search") {
    if (!input || typeof input !== "object" || !("query" in input) || typeof input.query !== "string" || !input.query.trim() || input.query.length > 16000) throw new Error("Expected a bounded search query");
    if (CLAUDE_SEARCH_HOSTS.some(host => readNetworkPolicy(getAgentDir()).deny.includes(host))) throw new Error("WEB_SEARCH_NETWORK_DENIED: a required Anthropic host is explicitly denied");
    const executable = claudeSearchBinary(cwd);
    const oauthToken = await claudeSearchToken(getAgentDir(), signal);
    input = { query: input.query, executable, oauthToken };
  }
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Confined request exceeds 1 MiB");
  const command = [process.execPath, "--import", join(root, "lib/resolve-pi.mjs"), join(root, "scripts/confined-tool.mjs"), service].map(quote).join(" ");
  const output = await runProcess(join(root, "scripts/codex-shell.mjs"), [
    ...(service === "search" ? ["--network-hosts", JSON.stringify(CLAUDE_SEARCH_HOSTS)] : service === "notes" ? ["--notes"] : ["web", "ci"].includes(service) ? [] : ["--offline"]), "-c", command,
  ], {
    cwd, signal, input: payload, graceMs: 3500, timeoutMs: service === "graphify" ? 180_000 : service === "search" ? 125_000 : 60_000, maxBytes: 32 * 1024 * 1024,
    env: { PI_PACKAGE_JSON: join(getPackageDir(), "package.json"), PI_CODING_AGENT_DIR: getAgentDir() },
  });
  return JSON.parse(output);
}
