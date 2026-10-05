// Fixed reader: no shell, caller-supplied headers, cookies, uploads or redirects.
import { curlFetch } from "../extensions/web/core.ts";
import { publicWebUrl } from "./codex-network.mjs";

const lifetime = new AbortController();
process.once("SIGTERM", () => lifetime.abort());
process.once("SIGINT", () => lifetime.abort());
try {
  if (process.env.PI_CONFINED !== "1" || process.argv.length !== 3) throw new Error("Exact web read requires the Codex sandbox and one URL");
  const result = await curlFetch(publicWebUrl(process.argv[2]), lifetime.signal, false);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
