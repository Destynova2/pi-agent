// Fixed worker; the installed parent broker is the only capability entry point.
import { inspectCheckpoint, runCheckpoint } from "../lib/jj-checkpoint.ts";
let input = "";
const controller = new AbortController(), cancel = () => controller.abort();
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
try {
  if (process.env.PI_CONFINED !== "1") throw new Error("Confined checkpoint worker required");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error("Checkpoint input too large");
  }
  const data = JSON.parse(input);
  if (typeof data.binary !== "string" || !data.binary.startsWith("/")) throw new Error("Expected the approved jj executable");
  const result = data.action === "inspect" ? await inspectCheckpoint(process.cwd(), data.binary, controller.signal)
    : data.action === "snapshot" ? await runCheckpoint(process.cwd(), data.binary, controller.signal)
    : (() => { throw new Error("Unknown checkpoint action"); })();
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  process.stdout.write(JSON.stringify({ error: message.startsWith("Checkpoint ") ? message : "Checkpoint worker failed; raw helper output withheld. Inspect prerequisites and sandbox diagnostics; no host retry." }));
} finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
