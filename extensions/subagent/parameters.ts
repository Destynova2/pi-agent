import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const DEFAULT_TIMEOUT_SECONDS = 300;

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

export const SubagentParams = Type.Object({
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
