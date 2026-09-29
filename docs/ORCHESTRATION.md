# Orchestration on large projects

For maintainers using `/orchestrate` and the `subagent` tool. These are bounded delegations, not an autonomous project scheduler.

## Working method

- Keep simple tasks direct. For larger work, preserve the original objective and split it into independently verifiable slices.
- Give each worker the goal, relevant paths, allowed changes, constraints and acceptance check. Children have isolated context: they do not inherit the caller's conversation.
- Use disjoint write-sets or run dependent edits sequentially. The write-set remains an instruction, not a filesystem sandbox.
- Record checkpoints in shared notes: completed slice, files, check command and exit code, remaining requirements, blockers, next step. Re-read the worktree when resuming; notes are not proof or snapshots.
- Review the combined diff and run integration checks before claiming the full task is complete. Per-worker success does not establish cross-module correctness.

Scout and reviewer can read `note_list`; they cannot call `note_add`. The notes extension only advertises note tools that are actually active. Their read-only policy is not an OS sandbox: they still have `bash` for inspection.

## Runtime limits and handoffs

| Boundary | Behavior |
|---|---|
| Delegation depth | Children cannot call the `subagent` tool recursively |
| Parallel execution | At most 8 tasks per call, 4 running children |
| Child deadline | `timeoutSeconds` on the tool call: default 1800, range 1–7200; applies per child in all modes |
| Child output | 32 MiB combined stdout/stderr limit; exceeding it fails the child |
| Inline result | Up to 12 KiB of output per child, plus status and artifact paths; applies to single, parallel and chain |
| UI history | Last 40 assistant messages; earlier messages and tool results remain in the JSONL trace |
| Task transport | A private file passed as a Pi `@file` argument, avoiding OS argument-length limits |
| Cancellation | Shared POSIX process-group supervisor, SIGTERM followed by SIGKILL if needed |
| Failure | Nonzero/signal exit, timeout, missing final text or a non-`stop` final response is not success |
| Leaked processes | Even a zero-exit parent fails if descendants remain in its process group; the supervisor stops them |

A failed chain stops before starting its next step. A parallel result is marked as an error if any task fails; completed siblings remain available. An already canceled call does not start queued children.

`{previous}` receives the preceding child's bounded output and artifact paths, not an unlimited transcript. Read the full report when details were omitted. The 12 KiB bound reduces maximum inline output; it is not a measured token, latency or cost improvement.

## Retained artifacts

Each started run has a private directory under `<agent-dir>/subagent-runs/run-*`:

- `task.md`: complete task text;
- `report.md`: final answer, or failure and partial answer;
- `trace.jsonl`: stdout events received before completion or the output limit.

Reports and traces are returned as readable paths after the child stops, including on process failure. New run directories use mode 0700 and files mode 0600. A trace is diagnostic data, **not** a resumable Pi session or a backup of edited files. If saving a report fails, the run is reported as failed rather than advertising a nonexistent report.

These files can contain source code, prompts, tool output or sensitive data. They are outside the project, are not uploaded by this feature, and have no automatic retention policy. Review and remove completed run directories manually when no longer needed; never delete a live run. Disk usage grows with retained runs.

The deadline and process supervision target Linux/macOS. Process groups do not sandbox commands or reliably contain a descendant that deliberately creates a new session; existing gate runners supervise their own hook groups.

## Sources and independent opinion

Compared the public jcode prompts at revision [`ebc402bf`](https://github.com/1jehuang/jcode/tree/ebc402bf3587604ffa9625673cabda27f4c02c5e): `system_prompt.md`, `swarm_prompt.md` and `mission_continuation.md`.

Useful ideas: explicit task boundaries, root-owned delegation, current-state inspection, and matching every requirement to evidence before completion. Not adopted: automatic commits, recursive delegation, unlimited mission continuation, or expanding beyond the user's approved scope. These prompts do not establish how jcode performs on large repositories.

Claude Opus 5.5 was consulted through Pi. The consultation recommended reusing the existing supervisor, making truncated reports recoverable, and aligning notes instructions with available tools. No private Claude Code implementation was inspected, and no claim of parity or superiority is made.

### DeepSeek Harness comparison

Compared the public [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/architecture.md), [subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/subagent.md) and [tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/tool-execution-pipeline.md) at revision `639ed015`. This comparison followed the changes above; no DeepSeek code or runtime was imported.

| Idea | Status here |
|---|---|
| Extend through plugins rather than another agent loop | Already uses Pi extensions and the shared process supervisor; no Cordis layer needed |
| Explicit cancellation and visible failure | Implemented for delegated runs; not equivalent to DeepSeek's full provider-capability validation |
| Align instructions with available capabilities | Implemented for notes tools; role restrictions are not a security sandbox |
| Durable child conversations with cold resume | Not implemented: `--no-session` children leave diagnostic artifacts, not resumable sessions |
| Authoritative session log and enforced tool guards | Not ported: a stdout trace is not a replay contract, and project gates are not a general tool-authorization pipeline |

The useful next candidates are native Pi child-session resumption and enforceable tool-scope checks, if those needs are confirmed. They require their own failure and authorization tests, not more prompt text. This comparison is not a benchmark or a reason to replace Pi's runtime.

## Validation

```sh
npm run check
npm run test:integration
```

If `pi` on PATH is a shell wrapper, set `PI_PACKAGE_JSON` to the installed `@earendil-works/pi-coding-agent/package.json` when running tests (see the test bootstrap in `tests/resolve-pi.mjs`).

Offline subprocess tests cover large task/file transport, a 1.2 MB UTF-8 report and chain handoff, cancellation, deadlines, signal/nonzero exits, incomplete answers, mixed parallel outcomes, and bounded UI history. Shared-supervisor tests cover streaming, output limits, callback failure and descendant cleanup. These tests establish harness behavior, not end-to-end project completion quality. That requires representative multi-module tasks and observation of the model's actual decisions.
