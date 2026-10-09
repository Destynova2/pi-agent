/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { StringDecoder } from "node:string_decoder";
import { runProcess } from "../../lib/process.ts";
import { CONFINED_TOOLS } from "../../lib/confined-tools.ts";
import { openRun } from "./runs.ts";
import { getFinalOutput, getPartialOutput, getResultOutput, isFailedResult, type SingleResult, type SubagentDetails } from "./results.ts";
import { subagentRenderer } from "./render.ts";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 300;

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	timeoutSeconds?: number;
	parentSession: string;
	tools: string[];
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	modelOverride: string | undefined,
	resume: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-approve", "--extension", fileURLToPath(new URL("../tool-policy/index.ts", import.meta.url))];
	const inheritsDispatchConfig = !modelOverride && !agent.model;
	const model = modelOverride ?? agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	const tools = [...new Set(agent.tools ?? dispatchDefaults.tools)].filter((name) => dispatchDefaults.tools.includes(name));

	let run: ReturnType<typeof openRun> | undefined;
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let traceFd: number | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getResultOutput(currentResult) }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		signal?.throwIfAborted();
		cwd = path.resolve(defaultCwd, cwd ?? ".");
		cwd = fs.realpathSync(cwd);
		const relative = path.relative(fs.realpathSync(defaultCwd), cwd);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error("Cannot delegate outside the task scope: child cwd must stay inside the parent workspace");
		}
		run = openRun({ parentSession: dispatchDefaults.parentSession, agent: agent.name, agentFile: agent.filePath,
			cwd: cwd ?? defaultCwd, tools, resume });
		const runDir = run.attemptDir;
		currentResult.resumeId = run.id;
		currentResult.sessionPath = run.sessionPath;
		currentResult.cwd = cwd;
		currentResult.timeoutSeconds = dispatchDefaults.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		args.push("--session", run.sessionPath, "--session-dir", path.dirname(run.sessionPath));
		if (run.tools.length) args.push("--tools", run.tools.join(",")); else args.push("--no-tools");
		const taskPath = path.join(runDir, "task.md");
		await fs.promises.writeFile(taskPath, `Task: ${task}`, { mode: 0o600 });
		currentResult.reportPath = path.join(runDir, "report.md");
		currentResult.tracePath = path.join(runDir, "trace.jsonl");
		traceFd = fs.openSync(currentResult.tracePath, "wx", 0o600);
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// File transport avoids the OS per-argument size limit, including chain handoffs.
		args.push(`@${taskPath}`);
		const invocation = getPiInvocation(args);
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const msg = event.message as Extract<Message, { role: "assistant" }>;
			currentResult.messages.push(msg);
			// ponytail: keep 40 assistant turns for UI; full JSONL stays on disk for inspection.
			if (currentResult.messages.length > 40) currentResult.messages.shift();
			currentResult.usage.turns++;
			if (msg.usage) {
				currentResult.usage.input += msg.usage.input || 0;
				currentResult.usage.output += msg.usage.output || 0;
				currentResult.usage.cacheRead += msg.usage.cacheRead || 0;
				currentResult.usage.cacheWrite += msg.usage.cacheWrite || 0;
				currentResult.usage.cost += msg.usage.cost?.total || 0;
				currentResult.usage.contextTokens = msg.usage.totalTokens || 0;
			}
			currentResult.stopReason = msg.stopReason;
			currentResult.errorMessage = msg.errorMessage;
			emitUpdate();
		};
		try {
			await runProcess(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd, signal,
				timeoutMs: (dispatchDefaults.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
				maxBytes: MAX_STREAM_BYTES,
				env: { PI_SUBAGENT_CHILD: "1", PI_AGENT_NAME: `${agent.name}-${run.id}` },
				onStdout: (chunk) => {
					fs.writeFileSync(traceFd!, chunk);
					buffer += decoder.write(chunk);
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				},
			});
		} finally {
			buffer += decoder.end();
			if (buffer.trim()) processLine(buffer);
		}
		currentResult.exitCode = 0;
		if (currentResult.stopReason !== "stop" || !getFinalOutput(currentResult.messages).trim()) {
			throw new Error(currentResult.errorMessage || `Incomplete subagent response (${currentResult.stopReason ?? "no final message"})`);
		}
	} catch (error) {
		currentResult.exitCode = 1;
		const message = error instanceof Error ? error.message : String(error);
		currentResult.errorMessage = [...new Set([currentResult.errorMessage, message].filter(Boolean))].join("\n");
		if (signal?.aborted) currentResult.stopReason = "aborted";
	} finally {
		try {
			if (traceFd !== undefined) fs.closeSync(traceFd);
			if (currentResult.reportPath) {
				const status = isFailedResult(currentResult) ? `FAILED: ${currentResult.errorMessage || currentResult.stopReason}\n\nPartial output:\n` : "";
				try {
					const output = isFailedResult(currentResult) ? getPartialOutput(currentResult.messages) : getFinalOutput(currentResult.messages);
					fs.writeFileSync(currentResult.reportPath, status + (output || "(no intermediate text; inspect trace.jsonl for tool activity)"), { mode: 0o600 });
				} catch (error) {
					currentResult.exitCode = 1;
					currentResult.errorMessage = `${currentResult.errorMessage || ""}\nCannot save report: ${String(error)}`.trim();
					currentResult.reportPath = undefined;
				}
			}
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		} finally { run?.release(); }
	}
	return currentResult;
}

const ModelOverride = Type.Optional(
	Type.String({ description: 'Model override as "provider/id" (e.g. "anthropic/claude-sonnet-5"). Defaults to the agent file, then the caller model.' }),
);

const ResumeId = Type.Optional(Type.String({ pattern: "^run-[A-Za-z0-9]{6}$", description: "Resume ID from a previous call in this parent session. Requires the same agent and cwd; only one invocation at a time." }));

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelOverride,
	resume: ResumeId,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: ModelOverride,
	resume: ResumeId,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Deprecated: untrusted project agents always require human approval; false cannot bypass it.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: ModelOverride,
	resume: ResumeId,
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 7200, default: DEFAULT_TIMEOUT_SECONDS, description: "Per-child execution deadline in seconds (all modes). Default 300, maximum 7200. Expiry stops the child process group and preserves partial reports; inspect before retrying." })),
});

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) return;
	// Pi marks execute() returns successful even when the object has an isError field.
	// Preserve rich partial results and set the authoritative flag through its supported result hook.
	pi.on("tool_result", (event) => {
		const details = event.details as SubagentDetails | undefined;
		if (event.toolName === "subagent" && Array.isArray(details?.results) &&
			(details.results.length === 0 || details.results.some(isFailedResult))) return { isError: true };
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents. Fresh children have isolated context; resume continues an owned native Pi session.",
			"Modes: single (agent + task), parallel (independent tasks only), chain (dependent steps with {previous} handoff; stops on failure).",
			"Default execution deadline: 300 seconds per child. Use a scoped acceptance check; inspect returned reports and current changes before any further delegation.",
			"On interruption, partial text and resume parameters are returned. Inspect that evidence, then continue the same owned session for remaining authorized work; do not restart completed work or treat partial findings as a final review.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const parentFile = ctx.sessionManager.getSessionFile();
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				timeoutSeconds: params.timeoutSeconds,
				parentSession: JSON.stringify([ctx.sessionManager.getSessionId(), parentFile ? fs.realpathSync(parentFile) : null]),
				tools: pi.getActiveTools().filter((name) => name !== "subagent" && name !== "request_network_access" && CONFINED_TOOLS.has(name)),
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (params.resume && !hasSingle) throw new Error("Top-level resume requires single mode; use resume on each parallel/chain item instead");
			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Pi project trust does not explicitly cover .pi/agents definitions.
			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = ctx.hasUI && !signal?.aborted && await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						{ signal },
					);
					if (!ok || signal?.aborted)
						return {
							isError: true,
							content: [{ type: "text", text: "Canceled: project-local agents require human approval; use a user-level agent for headless runs." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						step.model,
						step.resume,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getResultOutput(result);
				}
				return {
					content: [{ type: "text", text: getResultOutput(results[results.length - 1]) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						t.model,
						t.resume,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = isFailedResult(r)
						? `failed${r.stopReason ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					params.model,
					params.resume,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		...subagentRenderer,
	});
}
