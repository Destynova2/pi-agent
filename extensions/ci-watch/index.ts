/**
 * ci-watch: wake the agent when a pull/merge request changes state.
 *
 * Polls `gh` (GitHub) or `glab` (GitLab) in the background and sends one
 * follow-up message per transition: checks green, checks red, merged, closed,
 * review decision changed, merge conflict. Nothing on intermediate ticks.
 *
 * Tool: ci_watch { action: "start" | "status" | "stop" | "list", pr?, intervalSeconds?, timeoutMinutes? }
 * Command: /watch [pr#] | /watch status | /watch stop | /watch list
 *
 * This host file owns no process spawning: every `git`/`gh`/`glab` call happens in worker.ts,
 * run through lib/confined.ts (service "ci"). Here: timers, the watch map and session wiring.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runConfined } from "../../lib/confined.ts";
import { SessionTasks } from "../../lib/session-tasks.ts";
import type { CiInput, CiResult, Check, Provider, Snapshot } from "./worker.ts";

const DEFAULT_INTERVAL_S = 45;
const MIN_INTERVAL_S = 15;
const MAX_INTERVAL_S = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MIN = 120;
const MAX_TIMEOUT_MIN = 7 * 24 * 60;

interface Watch {
	key: string;
	cwd: string;
	provider: Provider;
	number: number;
	intervalMs: number;
	deadline: number;
	timer?: ReturnType<typeof setTimeout>;
	controller: AbortController;
	last?: Snapshot;
	polls: number;
	stopped: boolean;
}

export function finiteRange(name: string, value: number | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
	return value;
}

export function validatePr(pr: number | undefined): number | undefined {
	if (pr === undefined) return undefined;
	if (!Number.isFinite(pr) || !Number.isInteger(pr) || pr <= 0) throw new Error("pr must be a positive integer");
	return pr;
}

function formatChecks(checks: Check[]): string {
	if (checks.length === 0) return "  (no checks reported)";
	return checks.map((c) => `  - ${c.name}: ${c.state}${c.url ? ` ${c.url}` : ""}`).join("\n");
}

export function formatSnapshot(s: Snapshot): string {
	return [
		`${s.provider === "github" ? "PR" : "MR"} #${s.number} ${s.title}`,
		s.url,
		`state: ${s.state}, checks: ${s.overall}, review: ${s.review}${s.conflict ? ", CONFLICT" : ""}, head: ${s.head.slice(0, 8)}`,
		"checks:",
		formatChecks(s.checks),
	].join("\n");
}

/** Return a short description of what changed, or undefined if nothing worth a wake-up. */
export function transition(prev: Snapshot | undefined, next: Snapshot): string | undefined {
	if (next.state === "merged") return prev?.state === "merged" ? undefined : "merged";
	if (next.state === "closed") return prev?.state === "closed" ? undefined : "closed without merge";
	const events: string[] = [];
	if (next.conflict && !prev?.conflict) events.push("merge conflict");
	if (prev && next.review !== prev.review) events.push(`review: ${next.review}`);
	const headChanged = prev !== undefined && prev.head !== next.head;
	if (headChanged) events.push("new commits pushed");
	const settled = next.overall === "success" || next.overall === "failure";
	const prevSettledSame = prev !== undefined && prev.overall === next.overall && prev.head === next.head;
	if (settled && !prevSettledSame) events.push(`checks ${next.overall === "success" ? "green" : "red"}`);
	return events.length ? events.join(", ") : undefined;
}

/** Narrow injection seam: tests pass a fake implementation instead of spawning the real jail. */
export type CiFn = (cwd: string, input: CiInput, signal?: AbortSignal) => Promise<CiResult>;

const defaultCi: CiFn = async (cwd, input, signal) => await runConfined(cwd, "ci", input, signal) as CiResult;

export default function (pi: ExtensionAPI, ciImpl: CiFn = defaultCi) {
	const watches = new Map<string, Watch>();
	// Keyed by `${cwd}:${pr ?? "auto"}`, never just `cwd`: two concurrent start() calls for
	// different PRs on the same cwd must never share one promise/result.
	const starting = new Map<string, Promise<string>>();
	// One controller per in-flight start(), so stop() can cancel a start that hasn't produced a
	// watch yet (session boundaries cancel these too, via tasks.close() below).
	const startControllers = new Map<string, AbortController>();
	// Owns every op not tied to a persistent watch (start-before-watch-exists, status): closed and
	// replaced on every session boundary, so none of them can update stale state or wake late.
	let tasks = new SessionTasks();

	const ci = <R extends CiResult>(cwd: string, input: CiInput, signal?: AbortSignal): Promise<R> =>
		ciImpl(cwd, input, signal) as Promise<R>;

	const setStatus = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		const active = [...watches.values()].filter((w) => !w.stopped);
		ctx.ui.setStatus("ci-watch", active.length ? `watching ${active.map((w) => `#${w.number}`).join(" ")}` : undefined);
	};

	// Idempotent: a second stop() on an already-stopped watch is a no-op, so concurrent
	// stop/tick races never double-clear or re-wake.
	const stop = (w: Watch, ctx?: ExtensionContext) => {
		if (w.stopped) return;
		w.stopped = true;
		w.controller.abort();
		if (w.timer) clearTimeout(w.timer);
		watches.delete(w.key);
		setStatus(ctx);
	};

	// Stops every persistent watch AND every in-flight start() controller: a start/status still
	// running when the session resets must not survive it or write into a dead watches map.
	const stopAll = () => {
		for (const w of [...watches.values()]) stop(w);
		for (const controller of [...startControllers.values()]) controller.abort();
	};
	const resetTasks = async () => {
		stopAll();
		await tasks.close();
		tasks = new SessionTasks();
	};
	pi.on("session_start", resetTasks);
	pi.on("session_shutdown", () => {
		stopAll();
		return tasks.close();
	});
	pi.on("session_before_switch", resetTasks);
	pi.on("session_before_fork", resetTasks);
	pi.on("session_before_tree", resetTasks);

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
		try {
			const result = await ci<Extract<CiResult, { op: "snapshot" }>>(w.cwd, { op: "snapshot", cwd: w.cwd, provider: w.provider, number: w.number }, w.controller.signal);
			if (w.stopped) return; // stopped while the fetch was in flight: never wake stale.
			const snap = result.snapshot;
			const change = transition(w.last, snap);
			w.last = snap;
			if (change) {
				const done = snap.state !== "open";
				let log = "";
				if (change.includes("red")) {
					// On the same try as the snapshot fetch: a failed log request must hit the catch
					// below like any other error, not reject this detached tick() uncaught.
					try {
						const result2 = await ci<Extract<CiResult, { op: "log" }>>(w.cwd, { op: "log", cwd: w.cwd, snapshot: snap }, w.controller.signal);
						log = result2.text;
					} catch { log = "\n\n(Failed job log unavailable.)"; }
				}
				if (w.stopped) return;
				await wake(
					w,
					`ci-watch: ${change}.\n\n${formatSnapshot(snap)}${log}\n\n` +
						(done
							? "Watch ended."
							: snap.overall === "failure"
								? "Diagnose from the log above and report; do not push fixes unless the user asked for autonomous handling. Watch continues for new pushes."
								: "Watch continues until merged, closed, or timeout."),
				);
				if (w.stopped) return;
				if (done) {
					stop(w, ctx);
					return;
				}
			}
			if (w.stopped) return;
			if (Date.now() > w.deadline) {
				await wake(w, `ci-watch: timeout reached for #${w.number}, watch ended.\n\n${formatSnapshot(snap)}`);
				stop(w, ctx);
				return;
			}
			schedule(w, ctx);
		} catch (error) {
			// A stop() during any in-flight fetch above, or a genuine failure of any step (snapshot,
			// log, or wake), lands here: re-check w.stopped first (the AbortSignal rejection races the
			// stop flag), then apply the SAME deadline check a successful tick gets -- otherwise a
			// watch whose provider keeps erroring would never time out.
			if (w.stopped) return;
			if (w.polls % 10 === 0 && ctx?.hasUI) ctx.ui.notify(`ci-watch #${w.number}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			if (Date.now() > w.deadline) {
				stop(w, ctx);
				return;
			}
			schedule(w, ctx);
		}
	};

	const detectProvider = (cwd: string, signal?: AbortSignal) =>
		ci<Extract<CiResult, { op: "detect" }>>(cwd, { op: "detect", cwd }, signal).then((r) => r.provider);
	const currentPrNumber = (cwd: string, provider: Provider, signal?: AbortSignal) =>
		ci<Extract<CiResult, { op: "current" }>>(cwd, { op: "current", cwd, provider }, signal).then((r) => r.number);
	const fetchSnapshot = (cwd: string, provider: Provider, number: number, signal?: AbortSignal) =>
		ci<Extract<CiResult, { op: "snapshot" }>>(cwd, { op: "snapshot", cwd, provider, number }, signal).then((r) => r.snapshot);

	const start = async (
		cwd: string,
		pr: number | undefined,
		intervalSeconds: number | undefined,
		timeoutMinutes: number | undefined,
		signal: AbortSignal | undefined,
		ctx?: ExtensionContext,
	): Promise<string> => {
		validatePr(pr);
		finiteRange("intervalSeconds", intervalSeconds, MIN_INTERVAL_S, MAX_INTERVAL_S);
		finiteRange("timeoutMinutes", timeoutMinutes, 1, MAX_TIMEOUT_MIN);
		// One in-flight start per cwd+pr: a concurrent second call for the SAME pr reuses the same
		// promise instead of racing provider/number detection; a different pr gets its own, so it
		// never returns the wrong PR's result.
		const startKey = `${cwd}:${pr ?? "auto"}`;
		const existingStart = starting.get(startKey);
		if (existingStart) return existingStart;
		// A controller of its own, separate from tasks' session controller, so stop() can cancel
		// this exact start() even if other starts/the session stay alive.
		const abortController = new AbortController();
		startControllers.set(startKey, abortController);
		const combined = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
		// tasks.run throws before spawning anything if `combined` is already aborted (canceled tool
		// call, or a session boundary that fired first): a canceled start must never shell out.
		const run = tasks.run(async (taskSignal) => {
			const provider = await detectProvider(cwd, taskSignal);
			const number = pr ?? (await currentPrNumber(cwd, provider, taskSignal));
			const key = `${cwd}#${number}`;
			const existing = watches.get(key);
			if (existing && !existing.stopped) return `Already watching #${number}.\n\n${existing.last ? formatSnapshot(existing.last) : ""}`;
			const controller = new AbortController();
			const w: Watch = {
				key,
				cwd,
				provider,
				number,
				intervalMs: (intervalSeconds ?? DEFAULT_INTERVAL_S) * 1000,
				deadline: Date.now() + (timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000,
				controller,
				polls: 0,
				stopped: false,
			};
			w.last = await fetchSnapshot(cwd, provider, number, taskSignal);
			taskSignal.throwIfAborted();
			const concurrent = watches.get(key);
			if (concurrent) return `Already watching #${number}.`;
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
		}, combined);
		starting.set(startKey, run);
		try {
			return await run;
		} finally {
			starting.delete(startKey);
			startControllers.delete(startKey);
		}
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const text = await (async () => {
				switch (params.action) {
					case "start":
						return start(ctx.cwd, validatePr(params.pr), params.intervalSeconds, params.timeoutMinutes, signal, ctx);
					case "status":
						return tasks.run(async (taskSignal) => {
							const provider = await detectProvider(ctx.cwd, taskSignal);
							const number = validatePr(params.pr) ?? (await currentPrNumber(ctx.cwd, provider, taskSignal));
							return formatSnapshot(await fetchSnapshot(ctx.cwd, provider, number, taskSignal));
						}, signal);
					case "stop": {
						const targets = [...watches.values()].filter((w) => params.pr === undefined || w.number === params.pr);
						for (const w of targets) stop(w, ctx);
						// Also cancel any start() still in flight for this PR (or all, if pr is omitted): a
						// stop must not be silently missed just because the watch hadn't been created yet.
						for (const [key, controller] of startControllers) {
							if (params.pr === undefined || key === `${ctx.cwd}:${params.pr}`) controller.abort();
						}
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
					for (const controller of startControllers.values()) controller.abort();
					ctx.ui.notify("ci-watch stopped.", "info");
				} else if (a === "list") {
					ctx.ui.notify(list(), "info");
				} else if (a === "status") {
					const text = await tasks.run(async (taskSignal) => {
						const provider = await detectProvider(ctx.cwd, taskSignal);
						const number = b !== undefined ? validatePr(Number(b))! : await currentPrNumber(ctx.cwd, provider, taskSignal);
						return formatSnapshot(await fetchSnapshot(ctx.cwd, provider, number, taskSignal));
					}, ctx.signal);
					ctx.ui.notify(text, "info");
				} else {
					const pr = a ? Number(a) : undefined;
					if (a && (Number.isNaN(pr) || !Number.isFinite(pr))) {
						ctx.ui.notify("Usage: /watch [pr#] | status [pr#] | stop | list", "warning");
						return;
					}
					ctx.ui.notify(await start(ctx.cwd, validatePr(pr), undefined, undefined, ctx.signal, ctx), "info");
				}
			} catch (error) {
				ctx.ui.notify(`ci-watch: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
