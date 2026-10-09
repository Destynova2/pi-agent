// Loaded only through the trusted launcher. No arbitrary modules, commands or database paths.
import { readRequest } from "../lib/read-request.mjs";
import { executeNotes } from "../extensions/notes/worker.ts";
import { executeGraphify } from "../extensions/graphify/worker.ts";
import { gitInspect } from "../extensions/git-inspect/index.ts";
import { curlFetch, webSearch } from "../extensions/web/core.ts";
import { executeCi } from "../extensions/ci-watch/worker.ts";

const lifetime = new AbortController();
process.once("SIGTERM", () => lifetime.abort());
process.once("SIGINT", () => lifetime.abort());

try {
  if (process.env.PI_CONFINED !== "1") throw new Error("Confined worker requires the Codex sandbox launcher");
  const input = await readRequest(process.stdin);
  const service = process.argv[2];
  const result = service === "notes" ? await executeNotes({ ...input, cwd: process.cwd() })
    : service === "graphify" ? await executeGraphify(input, lifetime.signal)
    : service === "git" ? await gitInspect(process.cwd(), input, lifetime.signal)
    : service === "web" && typeof input.url === "string" ? await curlFetch(input.url, lifetime.signal)
    : service === "ci" ? await executeCi({ ...input, cwd: process.cwd() }, lifetime.signal)
    : service === "search" && typeof input.query === "string" ? await webSearch(input.query, lifetime.signal, input.executable, input.oauthToken)
    : (() => { throw new Error("Unsupported confined service"); })();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
