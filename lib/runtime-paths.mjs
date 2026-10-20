import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Executable resources belong to the package; user data belongs to getAgentDir().
export const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
export const PACKAGE_DIRECTORY = "packages/pi-agent-config";
export const RELEASES_DIRECTORY = "packages/pi-agent-config-releases";

/** Accept only this installer's exact local package locations, never a settings-supplied arbitrary path. */
export function isManagedPackage(agentDir, entry) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string") return false;
  if (source === join(agentDir, PACKAGE_DIRECTORY)) return true;
  const name = relative(join(agentDir, RELEASES_DIRECTORY), source);
  return /^[a-f0-9]{64}$/.test(name) && source === join(agentDir, RELEASES_DIRECTORY, name);
}

export function installedPackageRoot(agentDir, settings) {
  if (settings === undefined) {
    try { settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; settings = {}; }
  }
  const selected = settings.packages?.filter(entry => isManagedPackage(agentDir, entry)) ?? [];
  if (selected.length > 1) throw new Error("Multiple managed harness packages selected");
  return selected.length ? (typeof selected[0] === "string" ? selected[0] : selected[0].source) : join(agentDir, PACKAGE_DIRECTORY);
}
