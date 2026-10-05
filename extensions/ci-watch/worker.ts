/**
 * ci-watch worker -- the only module in this extension allowed to shell out to `git`, `gh` or
 * `glab`. The host (index.ts) keeps nothing but timers, the watch map and session wiring; every
 * network/provider operation routes through lib/confined.ts to executeCi.
 *
 * Contract: every input carries its own `cwd` (never ambient), matching the other confined
 * workers. Finite-range validation happens here too (defense in depth): this is the real jail
 * boundary, the host's own validation is only a fast, friendly rejection before the hop.
 */

import { runProcess } from "../../lib/process.ts";

export type Provider = "github" | "gitlab";

export interface Check {
	name: string;
	state: "pending" | "success" | "failure" | "skipped";
	url?: string;
}

export interface Snapshot {
	provider: Provider;
	number: number;
	title: string;
	url: string;
	state: "open" | "merged" | "closed";
	review: string;
	conflict: boolean;
	head: string;
	checks: Check[];
	overall: "pending" | "success" | "failure" | "none";
}

export type CiInput =
	| { op: "detect"; cwd: string }
	| { op: "current"; cwd: string; provider: Provider }
	| { op: "snapshot"; cwd: string; provider: Provider; number: number }
	| { op: "log"; cwd: string; snapshot: Snapshot };

export type CiResult =
	| { op: "detect"; provider: Provider }
	| { op: "current"; number: number }
	| { op: "snapshot"; snapshot: Snapshot }
	| { op: "log"; text: string };

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LOG_CHARS = 4000;

function validNumber(value: number): number {
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error(`invalid PR/MR number: ${value}`);
	return value;
}

function validProvider(value: unknown): Provider {
	if (value === "github" || value === "gitlab") return value;
	throw new Error(`invalid provider: ${String(value)}`);
}

async function sh(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return runProcess(cmd, args, { cwd, signal, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
}

async function detectProvider(cwd: string, signal?: AbortSignal): Promise<Provider> {
	const url = await sh("git", ["remote", "get-url", "origin"], cwd, signal);
	if (/github\.com/i.test(url)) return "github";
	if (/gitlab/i.test(url)) return "gitlab";
	throw new Error(`Remote origin not recognised as GitHub or GitLab: ${url}`);
}

function mapGithubCheck(c: Record<string, unknown>): Check {
	const name = String(c.name ?? c.context ?? "check");
	const url = typeof c.detailsUrl === "string" ? c.detailsUrl : typeof c.targetUrl === "string" ? c.targetUrl : undefined;
	if (c.__typename === "StatusContext") {
		const s = String(c.state ?? "").toUpperCase();
		const state: Check["state"] = s === "SUCCESS" ? "success" : s === "PENDING" || s === "EXPECTED" ? "pending" : "failure";
		return { name, state, url };
	}
	if (String(c.status ?? "").toUpperCase() !== "COMPLETED") return { name, state: "pending", url };
	const conclusion = String(c.conclusion ?? "").toUpperCase();
	if (conclusion === "SUCCESS") return { name, state: "success", url };
	if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return { name, state: "skipped", url };
	return { name, state: "failure", url };
}

export function overallOf(checks: Check[]): Snapshot["overall"] {
	const live = checks.filter((c) => c.state !== "skipped");
	if (live.length === 0) return "none";
	if (live.some((c) => c.state === "failure")) return "failure";
	if (live.some((c) => c.state === "pending")) return "pending";
	return "success";
}

async function fetchGithub(cwd: string, number: number, signal?: AbortSignal): Promise<Snapshot> {
	const out = await sh(
		"gh",
		["pr", "view", String(number), "--json", "number,title,url,state,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup"],
		cwd,
		signal,
	);
	const d = JSON.parse(out) as Record<string, unknown>;
	const checks = ((d.statusCheckRollup as Record<string, unknown>[]) ?? []).map(mapGithubCheck);
	const state = String(d.state).toLowerCase() as Snapshot["state"];
	return {
		provider: "github",
		number,
		title: String(d.title ?? ""),
		url: String(d.url ?? ""),
		state,
		review: String(d.reviewDecision ?? "") || "none",
		conflict: d.mergeStateStatus === "DIRTY",
		head: String(d.headRefOid ?? ""),
		checks,
		overall: overallOf(checks),
	};
}

async function fetchGitlab(cwd: string, number: number, signal?: AbortSignal): Promise<Snapshot> {
	const out = await sh("glab", ["mr", "view", String(number), "--output", "json"], cwd, signal);
	const d = JSON.parse(out) as Record<string, unknown>;
	const pipeline = (d.head_pipeline ?? d.pipeline) as Record<string, unknown> | undefined;
	const status = String(pipeline?.status ?? "");
	const checks: Check[] = pipeline
		? [
				{
					name: `pipeline ${pipeline.id ?? ""}`.trim(),
					state: status === "success" ? "success" : ["failed", "canceled"].includes(status) ? "failure" : status === "skipped" ? "skipped" : "pending",
					url: typeof pipeline.web_url === "string" ? pipeline.web_url : undefined,
				},
			]
		: [];
	const raw = String(d.state ?? "opened");
	const state: Snapshot["state"] = raw === "merged" ? "merged" : raw === "closed" ? "closed" : "open";
	let review = "none";
	try {
		const approvals = JSON.parse(await sh("glab", ["api", `projects/:id/merge_requests/${number}/approvals`], cwd, signal)) as Record<string, unknown>;
		if (approvals.approved === true) review = "approved";
	} catch {
		// Unauthenticated or no approval rules: keep "none".
	}
	return {
		provider: "gitlab",
		number,
		title: String(d.title ?? ""),
		url: String(d.web_url ?? ""),
		state,
		review,
		conflict: d.has_conflicts === true || d.detailed_merge_status === "conflict",
		head: String(d.sha ?? ""),
		checks,
		overall: overallOf(checks),
	};
}

async function fetchSnapshot(cwd: string, provider: Provider, number: number, signal?: AbortSignal): Promise<Snapshot> {
	return provider === "github" ? fetchGithub(cwd, number, signal) : fetchGitlab(cwd, number, signal);
}

async function currentPrNumber(cwd: string, provider: Provider, signal?: AbortSignal): Promise<number> {
	if (provider === "github") {
		const out = await sh("gh", ["pr", "view", "--json", "number"], cwd, signal);
		return Number((JSON.parse(out) as { number: number }).number);
	}
	const out = await sh("glab", ["mr", "view", "--output", "json"], cwd, signal);
	return Number((JSON.parse(out) as { iid: number }).iid);
}

async function failedLog(cwd: string, snap: Snapshot, signal?: AbortSignal): Promise<string> {
	const failing = snap.checks.find((c) => c.state === "failure" && c.url);
	if (!failing?.url) return "";
	const clip = (log: string) => (log.length > MAX_LOG_CHARS ? `…\n${log.slice(-MAX_LOG_CHARS)}` : log).trim();
	if (snap.provider === "github") {
		const m = failing.url.match(/\/actions\/runs\/(\d+)/);
		if (!m) return "";
		try {
			const log = await sh("gh", ["run", "view", m[1], "--log-failed"], cwd, signal);
			return `\n\nFailed job log (${failing.name}, run ${m[1]}, tail):\n\`\`\`\n${clip(log)}\n\`\`\``;
		} catch {
			return `\n\n(Could not fetch the failed log: gh run view ${m[1]} --log-failed)`;
		}
	}
	const m = failing.url.match(/\/pipelines\/(\d+)/);
	if (!m) return "";
	try {
		const jobs = JSON.parse(
			await sh("glab", ["api", `projects/:id/pipelines/${m[1]}/jobs?scope[]=failed&per_page=5`], cwd, signal),
		) as Array<Record<string, unknown>>;
		if (!jobs.length) return "";
		const names = jobs.map((j) => `${j.name} (job ${j.id})`).join(", ");
		try {
			const trace = await sh("glab", ["ci", "trace", String(jobs[0].id)], cwd, signal);
			return `\n\nFailed jobs: ${names}\nTrace of ${jobs[0].name} (tail):\n\`\`\`\n${clip(trace)}\n\`\`\``;
		} catch {
			return `\n\nFailed jobs: ${names}\n(Trace needs glab auth: glab ci trace ${jobs[0].id})`;
		}
	} catch {
		return `\n\n(Could not list failed jobs for pipeline ${m[1]})`;
	}
}

export async function executeCi(input: CiInput, signal?: AbortSignal): Promise<CiResult> {
	switch (input.op) {
		case "detect":
			return { op: "detect", provider: await detectProvider(input.cwd, signal) };
		case "current":
			return { op: "current", number: await currentPrNumber(input.cwd, validProvider(input.provider), signal) };
		case "snapshot":
			return {
				op: "snapshot",
				snapshot: await fetchSnapshot(input.cwd, validProvider(input.provider), validNumber(input.number), signal),
			};
		case "log":
			return { op: "log", text: await failedLog(input.cwd, input.snapshot, signal) };
		default:
			throw new Error(`Unsupported ci-watch operation: ${String((input as { op?: unknown }).op)}`);
	}
}
