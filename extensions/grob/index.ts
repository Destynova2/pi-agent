/**
 * grob: send model traffic through the local Grob proxy (routing, provider fallback, budget, audit log).
 *
 * Registers the `grob` provider on Grob's Anthropic Messages endpoint. The model list starts with
 * Grob's logical tiers (default/think/background) and is refreshed from `GET /v1/models`, so the
 * tiers and upstream mappings live in ~/.grob/config.toml, not here. Grob runs with no inbound
 * authentication on loopback; the dummy key only satisfies Pi's credential check.
 *
 * Env: GROB_URL (default http://127.0.0.1:13456). Inspect traffic with `grob watch` or ~/.grob/grob.log.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { DEFAULT_GROB_URL, grobFetch } from "../../lib/grob.ts";
import { registerGrobCommand } from "./command.ts";

export { DEFAULT_GROB_URL };
// Validate at request time: a malformed URL must not prevent the protective
// provider overrides from registering and leave the built-in transports active.
export const GROB_URL = (process.env.GROB_URL ?? DEFAULT_GROB_URL).replace(/\/+$/, "");
export const PROXIED_PROVIDERS = ["openai", "openai-codex", "anthropic"];
/** Logical routes Grob always exposes; `/v1/models` adds the explicitly configured upstream names. */
export const TIER_IDS = ["default-model", "think-model", "background-model"];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROBE_TIMEOUT_MS = 3000;

export interface GrobModel {
	id: string;
	name: string;
	input: ("text" | "image")[];
	cost: typeof ZERO_COST;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

/**
 * Pi metadata for one Grob model id. Logical tiers use Grob's default 128k guard; upstream names get their family's limits.
 * Only `think-model` and explicit upstream names advertise reasoning: a `thinking` block makes Grob take its think route,
 * which would send `default-model`/`background-model` to the think tier instead of their own mappings. Upstream effort
 * for the non-thinking tiers stays Grob's provider default.
 */
export function grobModel(id: string): GrobModel {
	const claude = id.startsWith("claude-");
	return {
		id,
		name: `${id} (Grob)`,
		input: claude ? ["text", "image"] : ["text"],
		cost: ZERO_COST, // Subscription traffic; `grob spend` is the accounting surface.
		reasoning: !TIER_IDS.includes(id) || id === "think-model",
		contextWindow: claude ? (/haiku/.test(id) ? 200_000 : 1_000_000) : id.startsWith("gpt-") ? 272_000 : 128_000,
		maxTokens: claude || id.startsWith("gpt-") ? 128_000 : 32_000,
	};
}

/** Lists the model ids Grob advertises; falls back to the logical tiers when the catalog is unreadable. */
export async function discoverModels(baseUrl: string, signal?: AbortSignal): Promise<GrobModel[]> {
	const ids = new Set(TIER_IDS);
	try {
		const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
        const response = await grobFetch(baseUrl)(`${baseUrl}/v1/models`, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
		if (response.ok) {
			const body = (await response.json()) as { data?: { id?: unknown }[] };
			for (const entry of body.data ?? []) if (typeof entry.id === "string" && entry.id) ids.add(entry.id);
		}
	} catch {
		// Offline or proxy down: the static tiers stay selectable and fail at request time with Pi's own error.
	}
	return [...ids].map(grobModel);
}

/** True when Grob answers /health; never sends credentials. */
export async function isHealthy(baseUrl: string): Promise<boolean> {
	try {
        return (await grobFetch(baseUrl)(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
    registerGrobCommand(pi, GROB_URL, isHealthy);
    const { stream, streamSimple } = anthropicMessagesApi();
    const transport: ReturnType<typeof grobFetch> = (input, init) => grobFetch(GROB_URL)(input, init);
    // Provider-specific compatibility options belong to the upstream API.
    // Grob owns that translation; Pi speaks the proxy's Anthropic protocol.
    const routed = (model: Model<Api>): Model<"anthropic-messages"> => ({ ...model, api: "anthropic-messages", baseUrl: GROB_URL, headers: undefined, compat: undefined });
    const options = <T extends StreamOptions>(value?: T) => ({ ...value, apiKey: "grob", headers: undefined, env: {}, fetch: transport, client: undefined });
    // Override the provider itself so restored models, compaction and nested reviewer
    // calls use Grob even when they retained an old model object or provider name.
    for (const provider of builtinProviders().filter(provider => PROXIED_PROVIDERS.includes(provider.id))) {
        const models = provider.getModels().map(routed);
        pi.registerProvider({
            id: provider.id, name: `${provider.name} via Grob`, baseUrl: GROB_URL,
            auth: { ...provider.auth, apiKey: {
                name: "Grob", login: async () => ({ type: "api_key", key: "grob" }),
                check: async () => ({ type: "api_key", source: "Grob" }),
                resolve: async () => ({ auth: { apiKey: "grob" }, source: "Grob" }),
            } },
            getModels: () => models,
            stream: (model, context, value) => stream(routed(model), context, options(value)),
            streamSimple: (model, context, value) => streamSimple(routed(model), context, options(value)),
        });
    }
	pi.registerProvider("grob", {
		name: "Grob proxy",
		baseUrl: GROB_URL,
		apiKey: "grob",
		api: "anthropic-messages",
		models: TIER_IDS.map(grobModel),
		refreshModels: (context) => discoverModels(GROB_URL, context.signal),
        streamSimple: (model, context, value) => streamSimple(routed(model), context, options<SimpleStreamOptions>(value)),
	});
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("grob", "Model traffic via Grob");
		if (!(await isHealthy(GROB_URL))) ctx.ui.notify("Grob proxy unavailable or GROB_URL invalid; check its loopback address or use /grob start", "warning");
	});
}
