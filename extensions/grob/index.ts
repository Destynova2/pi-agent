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

export const DEFAULT_GROB_URL = "http://127.0.0.1:13456";
export const GROB_URL = (process.env.GROB_URL ?? DEFAULT_GROB_URL).replace(/\/+$/, "");
/** Logical routes Grob always exposes; `/v1/models` adds the explicitly configured upstream names. */
export const TIER_IDS = ["default-model", "think-model", "background-model"];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const HEALTH_TIMEOUT_MS = 3000;

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
		const response = await fetch(`${baseUrl}/v1/models`, { signal });
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
		return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("grob", {
		name: "Grob proxy",
		baseUrl: GROB_URL,
		apiKey: "grob",
		api: "anthropic-messages",
		models: TIER_IDS.map(grobModel),
		refreshModels: (context) => discoverModels(GROB_URL, context.signal),
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!(await isHealthy(GROB_URL))) ctx.ui.notify(`Grob proxy unreachable at ${GROB_URL}; run \`grob start -d\``, "warning");
	});
}
