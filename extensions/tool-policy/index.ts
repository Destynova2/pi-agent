// Re-reads the trusted tool policy before authorization (deny before execute).
// Trust boundary: only user-loaded extensions; handlers loaded before this one still see
// and may mutate input first. Task rules recognize a narrow subset, not an OS sandbox.
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { DEFAULT_TOOL_POLICY, isValidToolName, loadToolPolicy, PATH_GUARDED_TOOLS, protectedPathViolation, TOOL_POLICY_FILE, toolDecision, type ToolPolicy } from "./core.ts";

import { taskDecision } from "./task.ts";

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

async function confirmOnce(ctx: ExtensionContext, toolName: string, input: unknown, signal: AbortSignal | undefined, source: string, testGrant = false): Promise<"once" | "task" | false> {
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
    const choices = ["Deny", "Allow once", "Allow this exact test command for this task"];
    const dialog = testGrant
      ? ctx.ui.select(`Project code has full filesystem/network access, including after edits.\n${source}\n${preview}`, choices, { signal }).then(choice => choice === choices[1] ? "once" as const : choice === choices[2] ? "task" as const : false)
      : ctx.ui.confirm(`Allow tool "${toolName}"?`, `Policy: ask (${source})\n\n${preview}`, { signal }).then(answer => answer === true ? "once" as const : false);
    const answer = await Promise.race([dialog, aborted]);
    return signal?.aborted ? false : answer;
  } catch {
    return false;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function (pi: ExtensionAPI) {
  const loadedAt = new Date().toISOString();
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
  let source = policy === DEFAULT_TOOL_POLICY ? `built-in; ${policyPath} absent` : policyPath;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  let generation = 0;
  let taskRoot: string | undefined;
  const grants = new Set<string>();
  let automatic = 0;
  let approvedCount = 0;
  let deniedCount = 0;
  const reset = () => {
    generation++;
    taskRoot = undefined;
    grants.clear();
    automatic = approvedCount = deniedCount = 0;
  };
  let hasTaskRules = policy && Object.values(policy).includes("task");
  const refreshPolicy = () => {
    const previous = JSON.stringify(policy);
    const previousError = loadError;
    try {
      agentDir ??= getAgentDir();
      policyPath = join(agentDir, TOOL_POLICY_FILE);
      policy = loadToolPolicy(agentDir);
      loadError = undefined;
    } catch (error) {
      policy = undefined; // Never keep an old allow rule after an unreadable/corrupt update.
      loadError = error instanceof Error ? error.message : String(error);
    }
    if (JSON.stringify(policy) !== previous || loadError !== previousError) {
      generation++;
      grants.clear();
    }
    source = policy === DEFAULT_TOOL_POLICY ? `built-in; ${policyPath} absent` : policyPath;
    hasTaskRules = policy && Object.values(policy).includes("task");
  };
  pi.on("session_start", () => { refreshPolicy(); reset(); });
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", (event, ctx) => {
    refreshPolicy();
    reset();
    taskRoot = ctx.cwd;
    if (hasTaskRules) event.systemPromptOptions.sections.tool_policy = "Task permissions use the current working directory, not inferred user intent. Prefer read/find/ls/grep for routine inspection. Shell scripts, compound commands, sensitive paths and external actions may need approval. Never work around a denial using another tool. Test grants expire when this task settles or new input starts.";
  });
  pi.on("agent_settled", (_event, ctx) => {
    const report = hasTaskRules && ctx.hasUI && automatic + approvedCount + deniedCount > 0;
    const summary = `Tool permissions: ${automatic} automatically authorized, ${approvedCount} explicitly authorized, ${deniedCount} blocked. These are permissions, not execution results. Task grants cleared.`;
    reset(); // Revoke before notifying: a failing UI must not preserve grants.
    if (report) ctx.ui.notify(summary, "info");
  });
  const block = (reason: string) => { deniedCount++; return { block: true, reason }; };

  pi.on("tool_call", async (event, ctx) => {
    refreshPolicy();
    if (!policy) return block(`Tool policy failed to load, every tool is blocked: ${loadError}. The user must fix or remove ${policyPath}; the next call re-reads it (/tool-policy shows details).`);
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
    const epoch = generation;
    const scoped = decision === "task" && taskRoot === ctx.cwd
      ? taskDecision(name, event.input as Record<string, unknown>, ctx.cwd, agentDir)
      : undefined;
    if (scoped?.action === "allow") { automatic++; return undefined; }
    const key = JSON.stringify([ctx.cwd, name, event.input]);
    if (scoped?.action === "test" && grants.has(key)) { automatic++; return undefined; }
    if (!ctx.hasUI) return block(`Tool "${name}" requires user confirmation and no UI is available; denied. ${scoped?.reason ?? ""}`);
    return serialize(async () => {
      refreshPolicy();
      if (epoch !== generation || signal?.aborted) return block(`Tool "${name}" blocked: task changed or aborted.`);
      if (scoped?.action === "test" && grants.has(key)) { automatic++; return undefined; }
      const approved = await confirmOnce(ctx, name, event.input, signal, `${source}${scoped ? `; ${scoped.reason}` : ""}`, scoped?.action === "test");
      refreshPolicy();
      if (!approved || epoch !== generation || signal?.aborted) return block(`Tool "${name}" was not approved for the current task.`);
      if (approved === "task") grants.add(key);
      approvedCount++;
      return undefined;
    });
  });

  pi.registerCommand("tool-policy", {
    description: "Show live permissions and runtime; reset revokes grants; reload waits for idle before reloading extensions",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") {
        ctx.ui.notify("Extension reload requested. Waiting for idle; active work is not canceled. After reload, run /tool-policy to verify the loaded runtime.", "info");
        await ctx.waitForIdle();
        await ctx.reload();
        return; // The old context is stale after reload.
      }
      refreshPolicy();
      if (args.trim() === "reset") reset();
      if (!policy) {
        ctx.ui.notify(`Tool policy: LOAD FAILED, all tools blocked.\n${loadError}\nFix or remove ${policyPath}; the next call re-reads it.`, "error");
        return;
      }
      const lines = Object.keys(policy).sort().map((key) => `  ${key}: ${policy![key]}`);
      ctx.ui.notify(`Tool policy (live file; re-read before each authorization)\nRuntime: Pi ${VERSION}; PID ${process.pid}; extension loaded ${loadedAt}\nSource: ${source}\nWorking directory: ${ctx.cwd}\nTask scope: ${taskRoot ?? "none"}; exact test grants: ${grants.size}\n${lines.join("\n")}`, "info");
    },
  });
}
