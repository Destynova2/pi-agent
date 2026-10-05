// Fixed Git worker. The broker starts it inside Codex, never as a host fallback.
import { inspectGit, performGit, setGitTransaction, validateGitRequest } from "../extensions/tool-policy/git-access-core.ts";
let input = "";
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("Git worker input exceeds 64 KiB");
  }
  const data = JSON.parse(input), request = validateGitRequest(data.request);
  if (!["inspect", "execute"].includes(data.action)) throw new Error("Invalid Git worker action");
  if (data.transaction) {
    if (data.action !== "execute" || !data.expected) throw new Error("Invalid Git transaction action");
    setGitTransaction(data.expected, data.transaction);
  }
  const result = data.action === "inspect" ? await inspectGit(process.cwd(), request, controller.signal) : await performGit(process.cwd(), request, data.expected, controller.signal);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  // Git helpers, hooks and remote servers may include credentials in diagnostics.
  const message = error instanceof Error ? error.message : "";
  const known = ["Git state changed during approval", "An unfinished Git operation", "Missing Git hook gate", "The index does not match", "A local branch is required", "Linked, special or oversized", "Linked or non-directory", "Push requires exactly one", "Unsupported or redirected worktree", "Nothing committed to push"];
  const lead = known.find(prefix => message.startsWith(prefix));
  process.stdout.write(JSON.stringify({ error: /PI_GIT_GUARD_(INDEX|REF)_CHANGED/.test(message) ? "Commit gate rejected changed index or reference state" : lead ?? "Git operation failed; raw helper output withheld", notice: "No automatic retry. Effects may already exist; inspect Git state. Hooks, signing and checks were not bypassed. If a sandbox denial prevents them, report it rather than using Dunst or a host shell." }));
} finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
