import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.ts";

/** Fixed worker programs only; model arguments cross stdin, never the shell command. */
export async function runConfined(cwd: string, service: "notes" | "graphify" | "git" | "web", input: unknown, signal?: AbortSignal): Promise<unknown> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Confined request exceeds 1 MiB");
  const command = [process.execPath, "--import", join(root, "lib/resolve-pi.mjs"), join(root, "scripts/confined-tool.mjs"), service].map(quote).join(" ");
  const output = await runProcess(join(root, "scripts/codex-shell.mjs"), [
    ...(service === "notes" ? ["--notes"] : service === "web" ? [] : ["--offline"]), "-c", command,
  ], {
    cwd, signal, input: payload, timeoutMs: service === "graphify" ? 180_000 : 60_000, maxBytes: 32 * 1024 * 1024,
    env: { PI_PACKAGE_JSON: join(getPackageDir(), "package.json"), PI_CODING_AGENT_DIR: getAgentDir() },
  });
  return JSON.parse(output);
}
