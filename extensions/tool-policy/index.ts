// Enforces the startup tool policy on every model tool call (deny before execute).
// Trust boundary: only user-loaded extensions; handlers loaded before this one still see
// and may mutate input first. Not an OS sandbox and not a shell-command classifier.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { DEFAULT_TOOL_POLICY, isValidToolName, loadToolPolicy, PATH_GUARDED_TOOLS, protectedPathViolation, TOOL_POLICY_FILE, toolDecision, type ToolPolicy } from "./core.ts";

const MAX_PREVIEW = 4000;

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value); // throws on typed arrays with elements: caller blocks
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
}

function currentSignal(ctx: ExtensionContext): AbortSignal | undefined {
  try {
    return ctx.signal;
  } catch {
    return AbortSignal.abort(); // stale context: treat as aborted
  }
}

async function confirmOnce(ctx: ExtensionContext, toolName: string, input: unknown, signal: AbortSignal | undefined, source: string): Promise<boolean> {
  if (signal?.aborted) return false;
  let preview: string;
  try {
    preview = JSON.stringify(input, null, 2) ?? "undefined";
  } catch {
    return false;
  }
  if (preview.length > MAX_PREVIEW) preview = `${preview.slice(0, MAX_PREVIEW)}\n[… ${preview.length - MAX_PREVIEW} more characters]`;
  let onAbort = () => {};
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const answer = await Promise.race([ctx.ui.confirm(`Allow tool "${toolName}"?`, `Policy: ask (${source})\n\n${preview}`, { signal }), aborted]);
    return answer === true && !signal?.aborted;
  } catch {
    return false;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function (pi: ExtensionAPI) {
  let agentDir: string | undefined;
  let policyPath = TOOL_POLICY_FILE;
  let policy: ToolPolicy | undefined;
  let loadError: string | undefined;
  try {
    agentDir = getAgentDir();
    policyPath = join(agentDir, TOOL_POLICY_FILE);
    policy = loadToolPolicy(agentDir);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  const source = policy === DEFAULT_TOOL_POLICY ? `built-in; ${policyPath} absent` : policyPath;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  const block = (reason: string) => ({ block: true, reason });

  pi.on("tool_call", async (event, ctx) => {
    if (!policy) return block(`Tool policy failed to load, every tool is blocked: ${loadError}. The user must fix or remove ${policyPath} and restart Pi (/tool-policy shows details).`);
    const name: unknown = event.toolName;
    if (!isValidToolName(name)) return block(`Tool name ${JSON.stringify(String(name))} is not valid for the tool policy.`);
    const signal = currentSignal(ctx);
    if (signal?.aborted) return block(`Tool "${name}" blocked: the turn was aborted.`);
    const decision = toolDecision(policy, name);
    if (decision === "deny") return block(`Tool "${name}" is denied by the tool policy (${source}).`);
    try {
      deepFreeze(event.input); // approved input == executed input; later mutation fails closed
    } catch (error) {
      return block(`Tool "${name}" input could not be frozen for authorization: ${(error as Error).message}`);
    }
    if (PATH_GUARDED_TOOLS.has(name)) {
      // Checked on the frozen input, whatever the allow/ask rule: the agent dir holds this policy,
      // agent definitions, extensions and resume metadata a later subagent would trust.
      const input = event.input as { path?: unknown } | null | undefined;
      let cwd: unknown;
      try { cwd = ctx.cwd; } catch { /* stale context */ }
      const violation = protectedPathViolation(agentDir!, input?.path, cwd);
      if (violation) return block(`Tool "${name}" blocked by the tool policy: target ${violation}. Edit it yourself outside Pi if intended.`);
    }
    if (decision === "allow") return undefined;
    if (!ctx.hasUI) return block(`Tool "${name}" requires user confirmation and no UI is available; denied.`);
    const approved = await serialize(() => confirmOnce(ctx, name, event.input, signal, source));
    return approved ? undefined : block(`Tool "${name}" was not approved by the user.`);
  });

  pi.registerCommand("tool-policy", {
    description: "Show the startup tool policy (allow/ask/deny), its source and any load error",
    handler: async (_args, ctx) => {
      if (!policy) {
        ctx.ui.notify(`Tool policy: LOAD FAILED, all tools blocked.\n${loadError}\nFix or remove ${policyPath}, then restart Pi.`, "error");
        return;
      }
      const lines = Object.keys(policy).sort().map((key) => `  ${key}: ${policy![key]}`);
      ctx.ui.notify(`Tool policy (startup snapshot, restart to reload)\nSource: ${source}\n${lines.join("\n")}`, "info");
    },
  });
}
