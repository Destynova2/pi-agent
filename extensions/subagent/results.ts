import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

const PER_TASK_OUTPUT_CAP = 12 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	reportPath?: string;
	tracePath?: string;
	resumeId?: string;
	sessionPath?: string;
	cwd?: string;
	timeoutSeconds?: number;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || Boolean(result.stopReason && result.stopReason !== "stop");
}

/** Intermediate text is evidence of progress, never a completed answer or verdict. */
export function getPartialOutput(messages: Message[]): string {
	return messages.filter((msg) => msg.role === "assistant")
		.map((msg) => msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
		.filter((text) => text.trim()).join("\n\n");
}

export function getResultOutput(result: SingleResult): string {
	const failed = result.exitCode !== -1 && isFailedResult(result);
	const partial = failed ? getPartialOutput(result.messages) : "";
	const output = failed
		? `${result.errorMessage || result.stderr || "Incomplete subagent response"}\n\nProgress: ${result.usage.turns} assistant turns; last response: ${result.stopReason ?? "none"}.\nPartial output (not a final verdict):\n${partial || "(no intermediate text; inspect the trace for tool activity)"}`
		: getFinalOutput(result.messages) || "(no output)";
	const bytes = Buffer.from(output);
	const text = bytes.length <= PER_TASK_OUTPUT_CAP
		? output
		: `${new StringDecoder("utf8").write(bytes.subarray(0, PER_TASK_OUTPUT_CAP))}\n\n[Output truncated; read the full report before relying on omitted details.]`;
	const artifacts = result.exitCode === -1 ? "" : [
		result.resumeId && `Resume: ${result.resumeId} (same parent session, agent and cwd)`,
		result.sessionPath && `Session: ${result.sessionPath}`,
		result.reportPath && `Report: ${result.reportPath}`,
		result.tracePath && `Trace: ${result.tracePath}`,
		failed && result.resumeId && result.cwd && `After inspecting the report, trace and current changes, continue the owned session with subagent: ${JSON.stringify({ agent: result.agent, resume: result.resumeId, cwd: result.cwd, ...(result.model ? { model: result.model } : {}), timeoutSeconds: result.timeoutSeconds, task: "Continue the original task from the saved session. Inspect current files and partial work, finish the remaining checks and return the final result. Do not repeat completed operations." })}\nNo automatic retry was started. Partial work does not satisfy a required final review.`,
	].filter(Boolean).join("\n");
	return text + (artifacts ? `\n\n${artifacts}` : "");
}
