// Fixed initialization worker. The parent always launches it inside Codex.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { initializeGit, validateGitInit } from "../lib/git-init.ts";
const controller = new AbortController(), cancel = () => controller.abort();
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error("Oversized initialization request");
  }
  const request = validateGitInit(JSON.parse(input)), worktree = realpathSync(process.cwd()), root = dirname(worktree);
  if (worktree !== join(root, "worktree")) throw new Error("Invalid initialization workspace");
  const result = await initializeGit({ root, worktree, metadata: join(root, "metadata") }, request, controller.signal);
  process.stdout.write(JSON.stringify({ result }));
} catch {
  // Hooks and signing helpers may print credentials. The real destination has
  // not been touched; the broker discards the failed private stage.
  process.stdout.write(JSON.stringify({ error: "Git initialization failed in private scratch space. Destination unchanged; hooks, signing and checks were not bypassed. Inspect their configuration and sandbox prerequisites before a new request." }));
} finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
