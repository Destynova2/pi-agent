# Orchestration on large projects

Ordinary requests now receive adaptive delegation guidance when the root agent has the `subagent` tool. `/orchestrate` remains an explicit shortcut. These are bounded delegations, not an autonomous project scheduler.

## Working method

- Start direct for simple or tightly coupled tasks. Deliver a first usable, tested slice before broad write delegation. Stabilize contracts before parallel work; use the existing sequential chain and `{previous}` handoff for dependencies. Integrate the first return directly rather than starting another correction round by default. Report scope growth or lack of a usable result before another long delegation.
- The model chooses the split from the request and observed code, without an extra planner call, fixed agent counts or file-count thresholds. This is automatic guidance, not a deterministic router or a guarantee of an optimal split.
- Give each worker the goal, relevant paths, allowed changes, constraints and acceptance check. Children have isolated context: they do not inherit the caller's conversation.
- Use disjoint write-sets or run dependent edits sequentially. The write-set remains an instruction, not a filesystem sandbox.
- Record checkpoints in shared notes: completed slice, files, check command and exit code, remaining requirements, blockers, next step. Re-read the worktree when resuming; notes are not proof or snapshots.
- Review the combined diff and run integration checks before claiming the full task is complete. Per-worker success does not establish cross-module correctness.

Scout and reviewer can read `note_list`; they cannot call `note_add` and no longer receive general `bash`. They use `git_inspect` for fixed-argument status, diffs, file lists and recent commits. Its helper-disabling flags and tests reduce Git configuration hazards; this is not an OS sandbox. Git must support `--no-lazy-fetch` (tested with 2.55.0); older versions fail explicitly rather than silently ignoring the protection. The notes extension only advertises tools that are active.

## Runtime limits and handoffs

| Boundary | Behavior |
|---|---|
| Delegation depth | Children cannot call the `subagent` tool recursively |
| Parallel execution | At most 8 tasks per call, 4 running children |
| Child deadline | `timeoutSeconds` on the tool call: default 300, range 1–7200; applies per child in all modes |
| Child output | 32 MiB combined stdout/stderr limit; exceeding it fails the child |
| Inline result | Up to 12 KiB of output per child, plus status and artifact paths; applies to single, parallel and chain |
| UI history | Last 40 assistant messages; earlier messages and tool results remain in the JSONL trace |
| Task transport | A private file passed as a Pi `@file` argument, avoiding OS argument-length limits |
| Cancellation | Shared POSIX process-group supervisor, SIGTERM followed by SIGKILL if needed |
| Failure | Nonzero/signal exit, timeout, missing final text or a non-`stop` final response is not success |
| Leaked processes | Even a zero-exit parent fails if descendants remain in its process group; the supervisor stops them |

A failed chain stops before starting its next step. A parallel result is marked as an error if any task fails; completed siblings remain available. An already canceled call does not start queued children. A deadline stops the child process group, not just the parent's wait; inspect the preserved partial report and current diff before retrying. This is a per-child limit, not a total-task budget: chains, queued parallel batches and explicit subsequent calls can take longer.

`{previous}` receives the preceding child's bounded output and artifact paths, not an unlimited transcript. Read the full report when details were omitted. The 12 KiB bound reduces maximum inline output; it is not a measured token, latency or cost improvement.

On macOS, signaling a zombie-only process group can return `EPERM` until its parent reaps it; this does not necessarily indicate a permission change. The supervisor retries the same signal once after yielding for 10 ms. `ESRCH` then confirms the group is gone; a repeated `EPERM` remains a cleanup failure. Cancellation cannot become success during that wait. This follows Darwin's [`killpg1`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c#L1675) behavior and is covered by real-process and fault-injection regressions, not by treating permission errors as successful cleanup.

## Retained artifacts

Each child has a private directory under `<agent-dir>/subagent-runs/run-*`:

- `session.jsonl`: the native Pi session, including finalized context and compaction entries;
- `owner.json`: parent session, role, working directory and capability ceiling;
- `active.lock`: exclusive invocation lock, removed after supervised cleanup;
- `attempt-*/task.md`, `report.md`, `trace.jsonl`: separate task, answer and stdout artifacts for each invocation.

Reports and traces are returned as readable paths after the child stops, including on process failure. New run directories use mode 0700 and files mode 0600. A trace is diagnostic data, **not** a resumable session or a backup of edited files. Only the separate native `session.jsonl` supplies resumed context. If saving a report fails, the run is reported as failed rather than advertising a nonexistent report.

These files can contain source code, prompts, tool output or sensitive data. They are outside the project, are not uploaded by this feature, and have no automatic retention policy. Review and remove completed run directories manually when no longer needed; never delete a live run. Disk usage grows with retained runs.

The deadline and process supervision target Linux/macOS. Process groups do not sandbox commands or reliably contain a descendant that deliberately creates a new session; existing gate runners supervise their own hook groups.

## Resume a child

Pass the returned `Resume: run-XXXXXX` value in `resume` alongside `agent` and the next `task`. Single calls and individual parallel/chain items accept it. The same parent Pi session, agent file/name and canonical working directory are required. If the original call set `cwd`, pass that same directory again. Restarting Pi with the same parent session preserves ownership; an unrelated or forked parent does not acquire the child.

Pi opens the existing native session through `--session`; it owns history reconstruction and compaction. No transcript replay engine or automatic retry of tool side effects is added. Each follow-up gets a fresh artifact directory. Another invocation of the same child is rejected while locked. Permissions can only narrow across resumes.

Missing, corrupt, oversized (64 MiB) or incomplete session files are rejected without automatic repair. Current session format support is Pi v3. After a hard supervisor crash, a lock is deliberately not stolen: inspect `active.lock` and processes using that session path, confirm no child remains, back up the run directory, then remove only that stale lock manually. Do not delete a session or lock just to silence an error.

## Tool authorization

`extensions/tool-policy` gates model tool calls before execution, including extension tools. `/tool-policy` re-reads the trusted file and shows current rules and errors. Every authorization also re-reads it; policy edits require no reload. A changed policy revokes task grants and invalidates queued/open approvals. A corrupt or unreadable update blocks calls instead of keeping stale permissions. `<agent-dir>/tool-policy.json` is optional, user-owned, never loaded from the project, and not replaced by the installer.

- Built-in defaults allow read/search/list, edit/write, notes, graph inspection, `git_inspect` and `subagent`. Shell, network and other unlisted tools require one-shot human approval.
- A configured file fully replaces those defaults. Values are `allow`, `ask`, `deny` or `task`; `*` supplies the fallback (otherwise `ask`). Invalid files block every model tool; the human command remains available for diagnosis.
- `ask` without a UI is denied. Parallel confirmations are serialized; refusal, cancellation or an unavailable approval mechanism never becomes permission.
- Built-in edit/write cannot modify the agent directory, including via existing symlinks or symlinked ancestors. Approved arguments are frozen so later tool-call handlers cannot silently mutate them.
- Children get the intersection of role tools, current parent-active tools and the parent's current `allow`/`task` rules (re-read before each delegation), minus recursive delegation. The child re-evaluates `task` on every call; interactive test grants are never inherited. `ask` is not inherited as permission. Empty/malformed role lists grant no tools. Project agents always require human approval, even with general Pi project trust; use user-level definitions for headless runs. A model-supplied `confirmProjectAgents: false` cannot bypass this.
- Child processes ignore project executable resources (`--no-approve`) and explicitly load the policy extension. A resumed child's saved capability ceiling also applies.

The checked-in local `tool-policy.json` explicitly allows `bash` and its separate `bash_process` supervisor (`list`, `peek`, `kill`). Allowing `bash` alone does not authorize the supervisor. Unknown tools still use `*: ask`; these shell permissions are not a sandbox.

For example, a user-authored read-oriented policy:

```json
{
  "read": "allow",
  "grep": "allow",
  "find": "allow",
  "ls": "allow",
  "git_inspect": "allow",
  "note_list": "allow",
  "subagent": "allow",
  "edit": "ask",
  "write": "ask",
  "bash": "deny",
  "*": "ask"
}
```

The next tool call or `/tool-policy` observes policy edits once this extension version is loaded. `/tool-policy` shows the actual Pi version, PID, extension load time and working directory, not just the policy file on disk. Installing updated extension code still requires loading that code through reload/restart. Pi refuses the built-in `/reload` during an active response or compaction: its warning is not a successful reload. `/tool-policy reload` waits for idle before requesting a reload without canceling work. Old versions without this command need one successful idle `/reload`, or a restart with the saved session. Reloading extensions does not upgrade an already-running Pi executable. With defaults, a headless worker cannot run shell-based tests; it must report this and the parent performs the approved checks. Explicitly allowing `bash` in the user policy enables shell-capable workers when the parent/role also permits it, but grants arbitrary shell capabilities unless an OS sandbox separately confines execution. Do not enable it merely to suppress a denial.

### Codex shell sandbox (macOS)

Set `shellPath` in the user-owned `settings.json` to the absolute path of `scripts/codex-shell.mjs`, then reload Pi while idle. The script must be executable (`chmod +x scripts/codex-shell.mjs`). This adapter uses Pi >=0.99.1, the existing Codex CLI (tested with 0.146.0), and Node >=22.19. It makes no model calls and does not require Codex authentication. The default binary is `~/.local/bin/codex`; a trusted launcher environment can set `PI_CODEX_SANDBOX_BIN` to another installed binary.

- Native Bash, user `!` commands, and `@richardgill/pi-background-bash` use Pi's existing shell setting. Foreground/background execution, streaming, exit codes, timeouts and process-group cancellation remain owned by Pi/the background extension. No command-text rewriting or extra approval model is added.
- Codex applies macOS Seatbelt to Bash and its descendants: writes are limited to the command's initial working directory and a private per-project `TMPDIR`; network access is disabled. `.git`, `.codex` and `.agents` remain protected by Codex. The directory is the session/worker cwd, not an inferred parent repository or all of `~/workspace`. The sandbox guard also rejects single, parallel and chained delegations whose canonical cwd escapes the parent's directory.
- Outside reads remain allowed. The adapter is not a whole-agent sandbox: native file tools, LSP, Graphify, MCP, extension internals and model transport remain separate. Trusted extensions/toolchains and user configuration are assumed. Do not use another tool to bypass a denied shell action.
- `git commit`, `git push`, dependency downloads, local servers and Podman access can be blocked. A denial is an error, never permission to retry outside the sandbox. The adapter fails closed when the backend is missing, the platform is unsupported or launch fails.
- Codex configuration is isolated under `~/.cache/pi-codex-sandbox/config`, with explicit filesystem/network overrides. Scratch files persist under a cwd-hashed directory in the same cache; they are not committed and have no automatic retention policy. The user's normal Codex profiles, credentials and saved allow rules are not loaded.
- For model Bash calls, project `shellPath` overrides are refused by `extensions/codex-sandbox` while this global adapter is enabled. Human `!` commands use Pi's resolved shell setting; do not override it in project settings. `/codex-sandbox` reports the shell configured at session load. Updating files does not retrofit an already running shell: reload idle sessions; existing jobs retain their original permissions.

Validate the actual installed backend and background extension without providers:

```sh
node --test --import ./tests/resolve-pi.mjs tests/codex-shell.test.mjs tests/codex-sandbox.integration.test.mjs
```

Tests exercise project/temp writes, outside writes including symlinks and child processes, protected metadata, network binding denial, preserved outside-read behavior, missing-backend refusal, native/background execution, peek/kill and deadlines. The implementation follows Codex [`exec_policy.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/exec_policy.rs) and [`seatbelt.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/sandboxing/src/seatbelt.rs); it invokes `codex sandbox` directly rather than importing execution-policy allow rules that can bypass confinement.

### Task-scoped permissions

Use `task` instead of `allow`/`ask` for `bash`, `read`, `write`, `edit`, `find`, `ls` and `grep` to reduce routine prompts without allowing every shell command. It is opt-in; an absent policy still uses the original defaults. Explicit `ask` and `deny` remain unconditional.

- Scope is the working directory at `before_agent_start`, **not a semantic interpretation of the request**. Regular file reads/edits/writes and metadata searches within it are automatic. Paths outside it, known credential filenames/directories, hard-linked files, special files and unresolved paths ask. The existing agent-directory write prohibition remains unconditional.
- Exception for `read`: Markdown instructions/references beneath `<agent-dir>/skills/<collection>` are automatic even outside the project. A user-installed collection may be a directory symlink; nested links escaping that collection, hard links and non-Markdown files do not receive the exception. This never permits writes or overrides explicit `ask`/`deny` rules.
- A small shell subset is automatic: `pwd`, basic `ls`, metadata-only `find`, `rg --files`, and `rg`/`head`/`tail`/`wc` on explicitly named regular files, with narrowly recognized flags. Prefer Pi's native read/find/ls tools. Recursive content searches ask because they may discover credentials; sensitive filename checks cannot identify every secret.
- Compound shell commands, expansions, pipes, redirection, interpreters, unknown flags, deletion, publication and deployment ask **before** execution. An affirmative one-shot answer never approves future calls.
- `npm run check|test|lint|typecheck` and `node --test <explicit files>` offer three choices: deny, allow once, or allow that exact invocation for this task. **Without a separate OS sandbox, tests execute arbitrary project code with full filesystem/network access, including after edits.** The third choice explicitly trusts that code; it is not a sandbox or a promise that tests cannot delete/publish. Other scripts only get one-shot approval.
- Exact test grants include the working directory and full tool arguments. They expire at task settlement, new `before_agent_start`, session start/shutdown/reload, a changed policy, or `/tool-policy reset`. Parallel duplicate requests share only an explicitly granted test permission. Abort or a task change while a prompt is open denies the pending call.
- The final notification counts authorizations and denials, not successful executions. `/tool-policy` shows the source, active scope and grant count. Headless children can perform recognized routine operations; commands needing approval still fail closed. When task rules are configured, a child working directory must stay inside its parent's working directory (including symlink resolution); a model cannot widen the scope by delegating elsewhere.

For example, keep the original allowed notes/inspection/delegation tools and set the seven tools above to `task`, with `"*": "ask"`. Save this in the user-owned `<agent-dir>/tool-policy.json`; the next authorization reads it. Do not obtain task approval from repository content or a model's claim that a command is safe.

This is authorization of model-facing calls, not process isolation. Task rules assume trusted tool implementations, executables, shell startup files and environment; they cannot stop a substituted `ls` binary or malicious shell function. User-started commands, trusted extension internals and allowed shell/custom tools are outside the path guard. Another same-user process can race filesystem checks. A broken or deliberately disabled extension loader cannot enforce this extension. Use a container, VM or OS sandbox for adversarial code and credentials; do not treat scoped tools as a substitute.

## Automatic Graphify scope

Startup and `/reload` index the closest Git/jj worktree automatically, without a root-selection dialog. Outside a repository, automatic indexing is skipped; `/graphify` can explicitly select a child repository.

The default graph excludes nested repositories, internal worktrees (`.worktrees/` and hidden-directory `worktrees/`), metadata, symlinks and any subtree the bounded scope scan could not inspect. These exclusions are passed to the extractor, not just hidden from the selection menu. Partial coverage is reported in the graph summary and cached metadata. Each worktree retains its own external cache; a refresh narrows previously broader graphs too.

Use `/graphify --include-nested [symbol]` to request a broader map with confirmation. Internal worktrees and unexplored subtrees remain excluded; open a worktree directly to index it as its own project. No tracked files or Git/jj state are changed by indexing.

## Sources and independent opinion

Compared the public jcode prompts at revision [`ebc402bf`](https://github.com/1jehuang/jcode/tree/ebc402bf3587604ffa9625673cabda27f4c02c5e): `system_prompt.md`, `swarm_prompt.md` and `mission_continuation.md`.

Useful ideas: explicit task boundaries, root-owned delegation, current-state inspection, and matching every requirement to evidence before completion. Not adopted: automatic commits, recursive delegation, unlimited mission continuation, or expanding beyond the user's approved scope. These prompts do not establish how jcode performs on large repositories.

Claude Opus 5.5 was consulted through Pi. The consultation recommended reusing the existing supervisor, making truncated reports recoverable, and aligning notes instructions with available tools. No private Claude Code implementation was inspected, and no claim of parity or superiority is made.

### Runtime comparison: Jcode, Codex and Claude Code

Inspected Jcode at [`de65ade`](https://github.com/1jehuang/jcode/tree/de65ade33d514b31a43885318179b3622f321170) and Codex at [`2a34aef`](https://github.com/openai/codex/tree/2a34aef79484bf769b4b225f3f595755f2962170). This is source inspection, not a performance benchmark.

- Jcode's [`dag/schedule.rs`](https://github.com/1jehuang/jcode/blob/de65ade33d514b31a43885318179b3622f321170/crates/jcode-plan/src/dag/schedule.rs) dispatches only after declared dependencies complete and passes their artifacts forward. `comm_session.rs` rejects recursive spawning outside deep mode and enforces live-agent limits. Here, reuse the existing chain and failure stop instead of adding a task-graph engine. Neither implementation can infer an undeclared functional dependency reliably.
- Codex's [`agent/control/budget.rs`](https://github.com/openai/codex/blob/2a34aef79484bf769b4b225f3f595755f2962170/codex-rs/core/src/agent/control/budget.rs) accounts for shared rollout usage and reports budget exhaustion. Its `multi_agents/wait.rs` returns a timed-out wait without stopping workers. Here, the existing supervisor enforces actual child execution deadlines; no shared token-budget engine was added.
- Claude Code's [documented subagents](https://code.claude.com/docs/en/sub-agents) expose tool restrictions, resumable context and `maxTurns`. Its public [`feature-dev` command](https://github.com/anthropics/claude-code/blob/main/plugins/feature-dev/commands/feature-dev.md) prescribes separate exploration, architecture and review rounds. Those automatic rounds are not adopted: they can delay the first usable result. The public repository provides plugin sources, not the private core implementation; no private-core inspection is claimed.

Runtime-enforced here: child permissions, no recursive delegation, per-call concurrency, process deadlines and chain failure stops. First-slice priority, stable contracts and avoiding a second correction round are model guidance, not mechanical guarantees.

### DeepSeek Harness comparison

Compared the public [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/architecture.md), [subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/subsystems/subagent.md) and [tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/tool-execution-pipeline.md) at revision `639ed015`. These documents informed the subsequent adaptations; no DeepSeek code or runtime was imported.

| Idea | Status here |
|---|---|
| Extend through plugins rather than another agent loop | Already uses Pi extensions and the shared process supervisor; no Cordis layer needed |
| Explicit cancellation and visible failure | Implemented for delegated runs; not equivalent to DeepSeek's full provider-capability validation |
| Align instructions with available capabilities | Implemented for notes tools; role restrictions are not a security sandbox |
| Durable child conversations with cold resume | Implemented with native Pi sessions, parent ownership and exclusive invocation; no resident-agent/team scheduler |
| Authoritative session log and enforced tool guards | Pi owns persisted context; this extension adds name-based pre-execution authorization and child capability ceilings, not DeepSeek's whole registry/policy framework |

No DeepSeek runtime code was copied. This is not a benchmark or a claim of feature parity.

### Progressive splitting (Model Mitosis analogy)

The user suggested [Model Mitosis: ne plus se tromper entre les microservices et le monolithe](https://www.youtube.com/watch?v=HNQJW5iMZgQ), Julien Topcu and Josian Chevalier, Devoxx France 2024. Its public description discusses evolving software boundaries and splitting models incrementally without unnecessary coupling or scale costs. The transcript was unavailable; no claim of having watched the full talk is made.

The analogy here applies to work decomposition, not service architecture: start cohesive, split only at useful boundaries, then reassess. The automatic root guidance expresses that policy; runtime authorization, concurrency limits and verification remain separate controls.

## Validation

```sh
npm run check
npm run test:integration
```

If `pi` on PATH is a shell wrapper, set `PI_PACKAGE_JSON` to the installed `@earendil-works/pi-coding-agent/package.json` when running tests (see the test bootstrap in `tests/resolve-pi.mjs`).

Offline subprocess tests cover large task/file transport, a 1.2 MB UTF-8 report and chain handoff, cancellation, deadlines, signal/nonzero exits, incomplete answers, mixed parallel outcomes, bounded UI history, native resume ownership/locking/corruption and permission narrowing. Deterministic real-Pi CLI tests verify denied tools never execute, protected paths, downstream argument mutation and the authoritative subagent error flag without network or provider credentials. Git tests use hostile local helpers and a promisor remote sentinel. Shared-supervisor tests cover streaming, output limits, callback failure and descendant cleanup. These tests establish harness behavior, not end-to-end project completion quality. That requires representative multi-module tasks and observation of the model's actual decisions.
