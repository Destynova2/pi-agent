/**
 * ci-watch: wake the agent when a pull/merge request changes state.
 *
 * Polls `gh` (GitHub) or `glab` (GitLab) in the background and sends one
 * follow-up message per transition: checks green, checks red, merged, closed,
 * review decision changed, merge conflict. Nothing on intermediate ticks.
 *
 * Tool: ci_watch { action: "start" | "status" | "stop" | "list", pr?, intervalSeconds?, timeoutMinutes? }
 * Command: /watch [pr#] | /watch status | /watch stop | /watch list
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);

type Provider = "github" | "gitlab";

interface Check {
	name: string;
	state: "pending" | "success" | "failure" | "skipped";
	url?: string;
}

interface Snapshot {
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

interface Watch {
	key: string;
	cwd: string;
	provider: Provider;
	number: number;
	intervalMs: number;
	deadline: number;
	timer?: ReturnType<typeof setTimeout>;
	last?: Snapshot;
	polls: number;
	stopped: boolean;
}

const DEFAULT_INTERVAL_S = 45;
const DEFAULT_TIMEOUT_MIN = 120;
const MAX_LOG_CHARS = 4000;

async function sh(cmd: string, args: string[], cwd: string): Promise<string> {
	const { stdout } = await run(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
	return stdout;
}

async function detectProvider(cwd: string): Promise<Provider> {
	const url = (await sh("git", ["remote", "get-url", "origin"], cwd)).trim();
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

function overallOf(checks: Check[]): Snapshot["overall"] {
	const live = checks.filter((c) => c.state !== "skipped");
	if (live.length === 0) return "none";
	if (live.some((c) => c.state === "failure")) return "failure";
	if (live.some((c) => c.state === "pending")) return "pending";
	return "success";
}

async function fetchGithub(cwd: string, number: number): Promise<Snapshot> {
	const out = await sh(
		"gh",
		["pr", "view", String(number), "--json", "number,title,url,state,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup"],
		cwd,
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

async function fetchGitlab(cwd: string, number: number): Promise<Snapshot> {
	const out = await sh("glab", ["mr", "view", String(number), "--output", "json"], cwd);
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
	// Approvals are a separate endpoint; best effort, the MR itself is enough to watch.
	let review = "none";
	try {
		const approvals = JSON.parse(await sh("glab", ["api", `projects/:id/merge_requests/${number}/approvals`], cwd)) as Record<string, unknown>;
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

async function fetchSnapshot(w: Pick<Watch, "cwd" | "provider" | "number">): Promise<Snapshot> {
	return w.provider === "github" ? fetchGithub(w.cwd, w.number) : fetchGitlab(w.cwd, w.number);
}

async function currentPrNumber(cwd: string, provider: Provider): Promise<number> {
	if (provider === "github") {
		const out = await sh("gh", ["pr", "view", "--json", "number"], cwd);
		return Number((JSON.parse(out) as { number: number }).number);
	}
	const out = await sh("glab", ["mr", "view", "--output", "json"], cwd);
	return Number((JSON.parse(out) as { iid: number }).iid);
}

/** Return a short description of what changed, or undefined if nothing worth a wake-up. */
function transition(prev: Snapshot | undefined, next: Snapshot): string | undefined {
	if (next.state === "merged") return prev?.state === "merged" ? undefined : "merged";
	if (next.state === "closed") return prev?.state === "closed" ? undefined : "closed without merge";
	const events: string[] = [];
	if (next.conflict && !prev?.conflict) events.push("merge conflict");
	if (prev && next.review !== prev.review) events.push(`review: ${next.review}`);
	const headChanged = prev !== undefined && prev.head !== next.head;
	if (headChanged) events.push("new commits pushed");
	// Checks: report when the overall result settles (or re-settles after a push).
	const settled = next.overall === "success" || next.overall === "failure";
	const prevSettledSame = prev !== undefined && prev.overall === next.overall && prev.head === next.head;
	if (settled && !prevSettledSame) events.push(`checks ${next.overall === "success" ? "green" : "red"}`);
	return events.length ? events.join(", ") : undefined;
}

async function failedLog(cwd: string, snap: Snapshot): Promise<string> {
	const failing = snap.checks.find((c) => c.state === "failure" && c.url);
	if (!failing?.url) return "";
	const clip = (log: string) => (log.length > MAX_LOG_CHARS ? `…\n${log.slice(-MAX_LOG_CHARS)}` : log).trim();
	if (snap.provider === "github") {
		const m = failing.url.match(/\/actions\/runs\/(\d+)/);
		if (!m) return "";
		try {
			const log = await sh("gh", ["run", "view", m[1], "--log-failed"], cwd);
			return `\n\nFailed job log (${failing.name}, run ${m[1]}, tail):\n\`\`\`\n${clip(log)}\n\`\`\``;
		} catch {
			return `\n\n(Could not fetch the failed log: gh run view ${m[1]} --log-failed)`;
		}
	}
	const m = failing.url.match(/\/pipelines\/(\d+)/);
	if (!m) return "";
	try {
		const jobs = JSON.parse(await sh("glab", ["api", `projects/:id/pipelines/${m[1]}/jobs?scope[]=failed&per_page=5`], cwd)) as Array<Record<string, unknown>>;
		if (!jobs.length) return "";
		const names = jobs.map((j) => `${j.name} (job ${j.id})`).join(", ");
		try {
			const trace = await sh("glab", ["ci", "trace", String(jobs[0].id)], cwd);
			return `\n\nFailed jobs: ${names}\nTrace of ${jobs[0].name} (tail):\n\`\`\`\n${clip(trace)}\n\`\`\``;
		} catch {
			return `\n\nFailed jobs: ${names}\n(Trace needs glab auth: glab ci trace ${jobs[0].id})`;
		}
	} catch {
		return `\n\n(Could not list failed jobs for pipeline ${m[1]})`;
	}
}

function formatChecks(checks: Check[]): string {
	if (checks.length === 0) return "  (no checks reported)";
	return checks.map((c) => `  - ${c.name}: ${c.state}${c.url ? ` ${c.url}` : ""}`).join("\n");
}

function formatSnapshot(s: Snapshot): string {
	return [
		`${s.provider === "github" ? "PR" : "MR"} #${s.number} ${s.title}`,
		s.url,
		`state: ${s.state}, checks: ${s.overall}, review: ${s.review}${s.conflict ? ", CONFLICT" : ""}, head: ${s.head.slice(0, 8)}`,
		"checks:",
		formatChecks(s.checks),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const watches = new Map<string, Watch>();

	const setStatus = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		const active = [...watches.values()].filter((w) => !w.stopped);
		ctx.ui.setStatus("ci-watch", active.length ? `watching ${active.map((w) => `#${w.number}`).join(" ")}` : undefined);
	};

	const stop = (w: Watch, ctx?: ExtensionContext) => {
		w.stopped = true;
		if (w.timer) clearTimeout(w.timer);
		watches.delete(w.key);
		setStatus(ctx);
	};

	const stopAll = () => {
		for (const w of watches.values()) stop(w);
	};
	pi.on("session_shutdown", stopAll);
	pi.on("session_before_switch", stopAll);

	const wake = async (w: Watch, text: string) => {
		await pi.sendMessage(
			{ customType: "ci-watch", content: text, display: true, details: { number: w.number, provider: w.provider } },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const schedule = (w: Watch, ctx?: ExtensionContext) => {
		if (w.stopped) return;
		w.timer = setTimeout(() => void tick(w, ctx), w.intervalMs);
		w.timer.unref?.();
	};

	const tick = async (w: Watch, ctx?: ExtensionContext) => {
		if (w.stopped) return;
		w.polls += 1;
		let snap: Snapshot;
		try {
			snap = await fetchSnapshot(w);
		} catch (error) {
			if (w.polls % 10 === 0 && ctx?.hasUI) ctx.ui.notify(`ci-watch #${w.number}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			schedule(w, ctx);
			return;
		}
		const change = transition(w.last, snap);
		w.last = snap;
		if (change) {
			const done = snap.state !== "open";
			const log = change.includes("red") ? await failedLog(w.cwd, snap) : "";
			await wake(
				w,
				`ci-watch: ${change}.\n\n${formatSnapshot(snap)}${log}\n\n` +
					(done
						? "Watch ended."
						: snap.overall === "failure"
							? "Diagnose from the log above and report; do not push fixes unless the user asked for autonomous handling. Watch continues for new pushes."
							: "Watch continues until merged, closed, or timeout."),
			);
			if (done) {
				stop(w, ctx);
				return;
			}
		}
		if (Date.now() > w.deadline) {
			await wake(w, `ci-watch: timeout reached for #${w.number}, watch ended.\n\n${formatSnapshot(snap)}`);
			stop(w, ctx);
			return;
		}
		schedule(w, ctx);
	};

	const start = async (
		cwd: string,
		pr: number | undefined,
		intervalSeconds: number | undefined,
		timeoutMinutes: number | undefined,
		ctx?: ExtensionContext,
	): Promise<string> => {
		const provider = await detectProvider(cwd);
		const number = pr ?? (await currentPrNumber(cwd, provider));
		const key = `${cwd}#${number}`;
		const existing = watches.get(key);
		if (existing && !existing.stopped) return `Already watching #${number}.\n\n${existing.last ? formatSnapshot(existing.last) : ""}`;
		const w: Watch = {
			key,
			cwd,
			provider,
			number,
			intervalMs: Math.max(15, intervalSeconds ?? DEFAULT_INTERVAL_S) * 1000,
			deadline: Date.now() + (timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000,
			polls: 0,
			stopped: false,
		};
		w.last = await fetchSnapshot(w);
		watches.set(key, w);
		setStatus(ctx);
		if (w.last.state !== "open") {
			stop(w, ctx);
			return `#${number} is already ${w.last.state}; nothing to watch.\n\n${formatSnapshot(w.last)}`;
		}
		schedule(w, ctx);
		const settled = w.last.overall === "success" || w.last.overall === "failure";
		return (
			`Watching #${number} every ${w.intervalMs / 1000}s (timeout ${Math.round((w.deadline - Date.now()) / 60_000)} min). ` +
			`You will be woken on: checks green/red, merge, close, review change, conflict, new push.` +
			(settled ? ` Checks are already ${w.last.overall}; you will be woken again only after a new push.` : "") +
			`\n\n${formatSnapshot(w.last)}`
		);
	};

	const list = (): string => {
		const active = [...watches.values()].filter((w) => !w.stopped);
		if (!active.length) return "No active watch.";
		return active.map((w) => `#${w.number} (${w.provider}, ${w.polls} polls, ${Math.max(0, Math.round((w.deadline - Date.now()) / 60_000))} min left)`).join("\n");
	};

	pi.registerTool({
		name: "ci_watch",
		label: "CI watch",
		description:
			"Watch a GitHub PR or GitLab MR in the background and receive a follow-up message when checks turn green or red, the PR is merged or closed, a review decision changes, or a conflict appears. Defaults to the PR of the current branch. Use action 'status' for a one-shot snapshot without watching.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop"), Type.Literal("list")]),
			pr: Type.Optional(Type.Number({ description: "PR/MR number. Default: the one for the current branch." })),
			intervalSeconds: Type.Optional(Type.Number({ description: `Polling interval, min 15. Default ${DEFAULT_INTERVAL_S}.` })),
			timeoutMinutes: Type.Optional(Type.Number({ description: `Stop watching after this long. Default ${DEFAULT_TIMEOUT_MIN}.` })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = await (async () => {
				switch (params.action) {
					case "start":
						return start(ctx.cwd, params.pr, params.intervalSeconds, params.timeoutMinutes, ctx);
					case "status": {
						const provider = await detectProvider(ctx.cwd);
						const number = params.pr ?? (await currentPrNumber(ctx.cwd, provider));
						return formatSnapshot(await fetchSnapshot({ cwd: ctx.cwd, provider, number }));
					}
					case "stop": {
						const targets = [...watches.values()].filter((w) => params.pr === undefined || w.number === params.pr);
						for (const w of targets) stop(w, ctx);
						return targets.length ? `Stopped ${targets.map((w) => `#${w.number}`).join(", ")}.` : "No matching watch.";
					}
					case "list":
						return list();
				}
			})();
			return { content: [{ type: "text", text }], details: { action: params.action } };
		},
	});

	pi.registerCommand("watch", {
		description: "Watch the current PR/MR: /watch [pr#] | status | stop | list",
		handler: async (args, ctx) => {
			const [a, b] = args.trim().split(/\s+/);
			try {
				if (a === "stop") {
					for (const w of [...watches.values()]) stop(w, ctx);
					ctx.ui.notify("ci-watch stopped.", "info");
				} else if (a === "list") {
					ctx.ui.notify(list(), "info");
				} else if (a === "status") {
					const provider = await detectProvider(ctx.cwd);
					const number = b ? Number(b) : await currentPrNumber(ctx.cwd, provider);
					ctx.ui.notify(formatSnapshot(await fetchSnapshot({ cwd: ctx.cwd, provider, number })), "info");
				} else {
					const pr = a ? Number(a) : undefined;
					if (a && Number.isNaN(pr)) {
						ctx.ui.notify("Usage: /watch [pr#] | status [pr#] | stop | list", "warning");
						return;
					}
					ctx.ui.notify(await start(ctx.cwd, pr, undefined, undefined, ctx), "info");
				}
			} catch (error) {
				ctx.ui.notify(`ci-watch: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
