# Latency and context: Pi configuration vs Jcode

## What was inspected

Jcode was shallow-cloned, not installed or executed, at `76df6464bf64b504996056b8934ec4ec6e8a4d2d` into `/tmp/pi-jcode-source-ZR2dbr`. Earlier work inspected only selected prompts. No Rust build, installer, credential import or runtime migration was performed.

The comparison covers server sharing, prompt caching, tool discovery and bounded continuation. It is not a whole-repository audit or a same-workload Jcode/Pi benchmark.

## Local measurements

Pi 0.87.1, Node 26.9.0, Linux, 2026-09-29. Twelve interleaved samples per configuration after two discarded warmups each. Wall time is process spawn to successful RPC `get_state`, with a fresh in-memory session, offline mode and **automatic Graphify disabled in every case**. Filesystem caches are warm. PSS is sampled for the idle Pi process, not its descendants or a loaded conversation. Small-sample p95 values are descriptive, not production tail guarantees.

| Configuration | Median ready | Observed p95 | Median PSS |
|---|---:|---:|---:|
| Pi without extensions, skills, templates, themes or context files | 215 ms | 230 ms | 72.1 MiB |
| Installed configuration | 395 ms | 401 ms | 92.7 MiB |
| Installed, without skill discovery | 374 ms | 388 ms | 87.0 MiB |
| Scout-equivalent tool selection, same resources | 400 ms | 411 ms | 92.6 MiB |

Artifacts: `/tmp/pi-startup-bench.py`, `/tmp/pi-startup-bench.json`. The raw samples allow recalculating percentiles. These measurements isolate local readiness, not model latency, TUI rendering or total task completion. Removing resources is an ablation, not a proposed equivalent configuration.

An offline local-provider probe of this installation found:

- 53 advertised skills: **44,803 characters** in the skills section. Full skill instructions load separately on demand.
- Initial system text: **56,171 characters**; without skills: **11,347 characters**.
- Fifteen active tool declarations: **15,723 JSON characters**, additional to the system text.
- These are character counts, **not tokenizer counts**. The fixture uses a non-Anthropic provider, so the Anthropic-only short documentation override does not apply.

Artifacts: `/tmp/pi-prompt-probe.ts`, `/tmp/pi-prompt-installed.json`, `/tmp/pi-prompt-no-skills.json`. The probe generated no external model request and executed no model tools.

A metadata-only sample of the active Pi-agent conversation's last 20 assistant requests reported 73,052 uncached input tokens and 2,359,936 cache-read tokens: approximately **97% cached input**. The recorded thinking level was `xhigh`. This is not evidence about every provider/session, nor an invoice or an end-to-end latency attribution. Cached tokens remain context and may still consume quota or incur cost.

## Why Jcode can be lightweight

Jcode uses a shared Rust server with thin clients. Later windows attach instead of starting a new agent runtime and MCP pool. Our launcher starts a separate Pi process per child invocation, even when resuming native history. Rust can reduce runtime overhead, but daemon sharing is an independent architectural advantage.

The website's approximately 10.4 MB is **marginal PSS per additional session**, not total server-plus-client memory. It cannot be compared directly with one idle Pi process or summed RSS. A fair comparison needs cold startup, warm attach, all process PSS, the same model and the same actual workload. Additional agents do not guarantee proportional throughput: dependencies, duplicate work and provider limits remain.

Source: [server architecture](https://github.com/1jehuang/jcode/blob/76df6464bf64b504996056b8934ec4ec6e8a4d2d/docs/SERVER_ARCHITECTURE.md), `src/cli/dispatch.rs:988-1059`, `crates/jcode-app-core/src/server.rs:1220-1269`.

## Useful ideas, without rebuilding Pi

| Mechanism | Jcode evidence | Decision for this configuration |
|---|---|---|
| Stable cached prefix | `crates/jcode-provider-anthropic/src/lib.rs:692-714,753-950` | Pi already has provider caching, session cache keys and append-only system updates. Do not add a second cache layer; measure cache misses first. |
| Deferred tool discovery | Same source; `crates/jcode-base/src/mcp/{schema_cache,manager}.rs` | Consider smaller role-specific skill/tool exposure. Preserve approval rules and discoverability; do not remove every skill globally. Dunst already exposes one dispatcher plus help. |
| Aggregate feedback | `crates/jcode-base/src/todo.rs:400-450` | Use Pi's native follow-up batching instead of one model continuation per queued completion. |
| Bounded continuation | `crates/jcode-app-core/src/agent/{turn_loops,response_recovery}.rs` | Keep existing deadlines, error handling, resume ownership and no-progress stops. Do not add unlimited auto-pokes or automatic publication. |
| Bounded memory recall | `docs/MEMORY_ARCHITECTURE.md` | Keep local notes. Current Jcode recall uses an extra remote relevance call; copying it would add latency, cost and privacy exposure. |
| Evidence-based completion | `crates/jcode-app-core/src/tool/todo.rs` | Prefer actual check results and remaining requirements to self-reported confidence percentages. Extra verification can improve correctness but is not free token reduction. |

The advertised 671-token Jcode core excludes tool schemas and other context. Compare complete provider requests, not a bare core against our skills-plus-extensions installation. Rust itself does not reduce the tokens in an identical request.

## Changes applied

1. `settings.json`: `followUpMode: "all"`. Messages already queued at a continuation boundary are handled together, in order. `tests/follow-up.test.ts` exercises real Pi core with a local stream: ten queued messages produce **2 requests total instead of 11**, with every message preserved. This is a deterministic call-count result, not a tenfold latency claim. Notifications arriving after an idle turn can still start separate turns. This setting also batches queued human follow-ups; urgent steering behavior is unchanged.
2. Adaptive and explicit orchestration guidance: batch independent investigations/read-only checks, work on a different slice while children run, request source ranges rather than full file dumps, stop discovery when the next change/check is clear, and resume checkpoints after compaction instead of repeating completed scans. This is model guidance, not an enforced scheduling or speed guarantee.
3. Notes guidance: `ask` is a project-only first-line excerpt. It is absent from the central mirror and cannot reconstruct the full request. Use the checkpoint's original-request/task-artifact pointer or session history, not repeated SQL searches in the wrong database.

## Next priorities and limits

- For a large configuration comparison, independent SSH/accounts, PAM/passwords, audit, and boot/network analyses may run together. Keep shared profile writes and final integration under one owner. Run checks concurrently only when they do not mutate the same state.
- After compaction: read the latest checkpoint and current diff, then continue its next step. Reopen only missing, changed or disputed evidence. Keep child resume IDs and evidence paths in the checkpoint.
- Consider medium reasoning for routine reconnaissance and focused high reasoning for unresolved high-risk questions. No model or reasoning setting was changed automatically.
- A lightweight scout/reviewer skill catalogue is the next context reduction candidate, but its task quality and access to required specialized instructions need an A/B check before making it the default.
- No skill removal, permission weakening, shared agent daemon, speculative Rust rewrite or change to the user's Ansible project was made. The Ansible excerpt shows duplicated exploration and compaction overhead; no numerical speedup is claimed for that project.

Restart existing Pi sessions to ensure the new queue setting and installed guidance are active. Installer merging preserves an explicit personal `followUpMode` setting.
