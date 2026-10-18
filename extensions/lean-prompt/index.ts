/**
 * lean-prompt: keep the first model call small, load the rest on demand.
 *
 * - Skills are advertised with one routing line each; Pi still loads SKILL.md on demand.
 * - Rarely used parent-only tools stay registered but dormant until `load_tools` activates them.
 *   Their exposure is unchanged (`model-only` never becomes callable by other tools); Pi then
 *   drops their declarations, guidelines and the matching prompt sections until they are loaded.
 *
 * ponytail: the loaded set lives in memory; a resumed session reloads with one `load_tools` call.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_BRIEF_LENGTH = 240;

/** Dormant until loaded; the one-line catalogue is what the model sees instead of each full declaration. */
export const DEFERRED_TOOLS: Record<string, string> = {
	request_build_access: "one-shot KVM Linux image build (ansible-playbook) with host networking, reviewed and supervised",
	request_podman_access: "Podman engine commands through the host CLI, approved per exact argv",
	request_host_access: "one approved host operation: Podman diagnostics, clipboard transfer, process info",
	git_repository_init: "initialize a separate repository with empty main, develop and one HTTPS remote",
	git_worktree_cleanup: "inspect, remove or prune Git worktrees with archived files and preserved branches",
	model_catalog: "cached Pi model registry snapshot without credential or quota probes",
	run_isolated: "run a command on explicit source copies in a disposable offline Linux job",
	dunst: "Mac desktop automation on the host, your real apps and logins; observation consent remembered, every action confirmed by the human",
	harness_update: "verify a pi-agent-config source on the host and install it, or install one pi package, after human confirmation",
	request_host_command: "one exact command on the host outside every sandbox (real browser, long-lived service), confirmed by the human each time",
};
/** Prompt sections that only describe deferred tools; returned by load_tools instead of sitting in every request. */
export const DEFERRED_SECTIONS: Record<string, string> = { podman_bridge: "request_podman_access", git_initialization: "git_repository_init", worktree_cleanup: "git_worktree_cleanup" };

/** First sentence, plus the first "Use when/for/this…" sentence when present, capped at MAX_BRIEF_LENGTH. */
export function briefDescription(text: string): string {
	const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
	const hint = sentences.slice(1).find(s => /^Use (when|for|this|it)\b/i.test(s));
	const brief = hint ? `${sentences[0]} ${hint}` : sentences[0];
	return brief.length <= MAX_BRIEF_LENGTH ? brief : `${brief.slice(0, MAX_BRIEF_LENGTH - 1).trimEnd()}…`;
}

export default function leanPrompt(pi: ExtensionAPI): void {
	const loaded = new Set<string>();
	const guidance = new Map<string, string>();

	pi.on("before_agent_start", event => {
		const options = event.systemPromptOptions;
		if (options.skills) options.skills = options.skills.map(skill => ({ ...skill, description: briefDescription(skill.description) }));
		const dormant = new Set(Object.keys(DEFERRED_TOOLS).filter(name => !loaded.has(name)));
		pi.setActiveTools(pi.getActiveTools().filter(name => !dormant.has(name)));
		for (const [section, tool] of Object.entries(DEFERRED_SECTIONS)) {
			const text = options.sections[section];
			if (text && dormant.has(tool)) { guidance.set(section, text); delete options.sections[section]; }
		}
	});

	pi.registerTool({
		name: "load_tools", label: "Load deferred tools", exposure: "model-only", executionMode: "sequential",
		description: `Activate rarely needed parent-only tools for this session before calling them; they are declared from the next model call with their usage rules. Available: ${Object.entries(DEFERRED_TOOLS).map(([name, line]) => `${name} (${line})`).join("; ")}.`,
		parameters: Type.Object({ tools: Type.Array(Type.String(), { description: "Tool names from the available list" }) }),
		execute: async (_id, params) => {
			const unknown = params.tools.filter(name => !(name in DEFERRED_TOOLS));
			if (unknown.length > 0) throw new Error(`Unknown deferred tools: ${unknown.join(", ")}. Available: ${Object.keys(DEFERRED_TOOLS).join(", ")}`);
			for (const name of params.tools) loaded.add(name);
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...params.tools])]);
			const notes = Object.entries(DEFERRED_SECTIONS).filter(([, tool]) => params.tools.includes(tool)).map(([section]) => guidance.get(section)).filter((text): text is string => !!text);
			return { content: [{ type: "text", text: [`Loaded: ${params.tools.join(", ")}.`, ...notes].join("\n\n") }], details: undefined };
		},
	});
}
