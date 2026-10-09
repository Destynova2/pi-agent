// Fixed Git worker. The broker starts it inside Codex, never as a host fallback.
import { inspectGit, performGit, setGitTransaction, validateGitRequest } from "../extensions/tool-policy/git-access-core.ts";
let input = "";
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Git worker input exceeds 1 MiB");
  }
  const data = JSON.parse(input), request = validateGitRequest(data.request);
  if (!["inspect", "execute"].includes(data.action)) throw new Error("Invalid Git worker action");
  if (process.env.PI_GIT_NETWORK_HOST && (data.action !== "execute" || request.operation !== "push" || new URL(data.expected?.remoteUrl).hostname !== process.env.PI_GIT_NETWORK_HOST || String(request.private_network === true) !== process.env.PI_GIT_PRIVATE_NETWORK)) throw new Error("Git network scope does not match the reviewed push");
  if (data.action === "execute" && request.private_network && !process.env.PI_GIT_NETWORK_HOST) throw new Error("Private Git networking requires its confined launcher");
  if (data.transaction) {
    if (data.action !== "execute" || !data.expected) throw new Error("Invalid Git transaction action");
    setGitTransaction(data.expected, data.transaction);
  }
  const cwd = request.repository ?? process.cwd();
  const result = data.action === "inspect" ? await inspectGit(cwd, request, controller.signal) : await performGit(cwd, request, data.expected, controller.signal);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  // Git helpers, hooks and remote servers may include credentials in diagnostics.
  const message = error instanceof Error ? error.message : "";
  const known = ["Git state changed during approval", "An unfinished Git operation", "Missing Git hook gate", "The index does not match", "A local branch is required", "Linked, special or oversized", "Linked or non-directory", "Push requires exactly one", "Unsupported or redirected worktree", "Nothing committed to push"];
  const lead = known.find(prefix => message.startsWith(prefix));
  const proxyDenied = /CONNECT tunnel failed, response 403/i.test(message);
  process.stdout.write(JSON.stringify({ error: /PI_GIT_GUARD_(INDEX|REF)_CHANGED/.test(message) ? "Commit gate rejected changed index or reference state" : proxyDenied ? "GIT_PROXY_CONNECT_DENIED: HTTPS proxy refused the tunnel (403); remote authentication has not been established" : lead ?? "Git operation failed; raw helper output withheld", notice: `${proxyDenied ? "Check the proxy policy and DNS resolution. If the authorized remote resolves to private addresses, git_access push with private_network=true requests one exact task-reviewed capability; a public-host grant alone cannot allow it. Explicit denies still win. " : ""}No automatic retry. Effects may already exist; inspect Git state. Hooks, signing and checks were not bypassed. If a sandbox denial prevents them, report it rather than using Dunst or a host shell.` }));
} finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
