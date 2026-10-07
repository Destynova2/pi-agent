// Read-only inventory; all Git/configuration-dependent code runs inside Codex.
import { inspectWorktrees, worktreeRequest } from "../lib/git-worktree.ts";
const controller = new AbortController(), cancel = () => controller.abort();
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
let input = "";
try {
  if (process.env.PI_CONFINED !== "1") throw new Error("Worktree inspection requires the confined worker");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error("Worktree request exceeds 16 KiB");
  }
  const request = worktreeRequest(JSON.parse(input));
  process.stdout.write(JSON.stringify({ result: await inspectWorktrees(process.cwd(), request, controller.signal) }));
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  process.stdout.write(JSON.stringify({ error: message.startsWith("Worktree ") ? message : "Worktree inspection failed inside Codex; check repository metadata and sandbox diagnostics. No cleanup performed." }));
} finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
