// Loaded only through the trusted launcher. No arbitrary modules, commands or database paths.
import { readFileSync } from "node:fs";
import { executeNotes } from "../extensions/notes/worker.ts";
import { executeGraphify } from "../extensions/graphify/worker.ts";
import { gitInspect } from "../extensions/git-inspect/index.ts";
import { curlFetch } from "../extensions/web/core.ts";

try {
  if (!process.env.CODEX_SANDBOX) throw new Error("Confined worker requires the Codex sandbox");
  const data = readFileSync(0);
  if (data.length > 1024 * 1024) throw new Error("Confined request exceeds 1 MiB");
  const input = JSON.parse(data.toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a request object");
  const service = process.argv[2];
  const result = service === "notes" ? await executeNotes({ ...input, cwd: process.cwd() })
    : service === "graphify" ? await executeGraphify(input)
    : service === "git" ? await gitInspect(process.cwd(), input)
    : service === "web" && typeof input.url === "string" ? await curlFetch(input.url)
    : (() => { throw new Error("Unsupported confined service"); })();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
