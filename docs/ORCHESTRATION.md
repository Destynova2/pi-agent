# Orchestration on large projects

This source branch adds confined Notes, Graphify, Git inspection, web helpers, CI queries, LSP and local MCP servers, plus delegation restricted to those executors. Dunst remains a distinct, human-approved host operation. Migration is not installed in the live runtime; authenticated live search and real configured language servers still need validation. Do not confuse fixture tests or source changes with activation in existing sessions.

## Working method

- Start direct for simple or tightly coupled tasks. Deliver a first usable, tested slice before broad write delegation. Stabilize contracts before parallel work; use the existing sequential chain and `{previous}` handoff for dependencies. Integrate the first return directly rather than starting another correction round by default. Report scope growth or lack of a usable result before another long delegation.
- The model chooses the split from the request and observed code, without an extra planner call, fixed agent counts or file-count thresholds. This is automatic guidance, not a deterministic router or a guarantee of an optimal split.
- Give each worker the goal, relevant paths, allowed changes, constraints and acceptance check. Children have isolated context: they do not inherit the caller's conversation.
- Use disjoint write-sets or run dependent edits sequentially. The write-set remains an instruction, not a filesystem sandbox.
- Record checkpoints in shared notes: completed slice, files, check command and exit code, remaining requirements, blockers, next step. Re-read the worktree when resuming; notes are not proof or snapshots.
- Review the combined diff and run integration checks before claiming the full task is complete. Per-worker success does not establish cross-module correctness.

Scout and reviewer can read `note_list`; they cannot call `note_add` and no longer receive general `bash`. They use `git_inspect` for fixed-argument status, diffs, file lists and recent commits. Its helper-disabling flags reduce Git configuration hazards; execution also runs inside the Codex sandbox. Git must support `--no-lazy-fetch` (tested with 2.55.0); older versions fail explicitly rather than silently ignoring the protection. The notes extension only advertises tools that are active.

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

## Strict tool sandbox

`extensions/tool-policy` now confines `read`, `write`, `edit`, `ls`, `find` and `grep` through `scripts/codex-tool.mjs` under the same Codex OS sandbox as Bash. It reuses Pi's native tool implementations, including edit validation and image handling. File calls are serialized per workspace; each has a 60-second deadline and 32 MiB output ceiling.

`bash` and its `bash_process` supervisor retain the existing launcher and background lifecycle. Notes, including automatic prompt capture and inbox polling, and Graphify, including startup indexing and root discovery, now dispatch to fixed jailed workers. Notes alone receives additional grants for project note storage, its Git exclude entry and `~/workspace/notes.db` with SQLite sidecars, never the whole workspace directory. Linked storage is refused. Graphify caches live under the private cwd-specific `TMPDIR`; existing external caches are not deleted. Git inspection is offline; `web_fetch` uses the managed network proxy.

Routine calls need no approval. `request_network_access` can add exact public hosts, never filesystem permissions. Unknown tools and executors not yet confined are denied. There is no unrestricted fallback. The legacy `tool-policy.json`, parser and shell classifier are removed; the installer backs up and deletes known legacy files. The dispatcher directory retains its name to replace the old installed entry point without loading two dispatchers.

Children inherit the intersection of role tools, active parent tools and the fixed confined-executor set, without recursive delegation or interactive network grants. Canonical child cwd must remain within its parent workspace in every mode, even with no policy file. Private session/report storage and model transport remain trusted host operations. Resumes can only narrow capabilities.

The installer sets `shellPath` and deploys the launchers, workers and SDK resolver. Restart Pi with `--no-approve` after a validated installation. Project resources are refused through `project_trust`; a session started with trusted project resources blocks permitted tools too. `/confined-tools` reports configuration, not proof that the backend can run. A missing adapter, changed cwd/shell or backend failure blocks execution.

The original LSP package stays installed at 0.4.4 with its extension filtered out (`extensions: []`). The replacement runs its actual lifecycle controller inside Codex: persistent servers, workspace previews/apply, diagnostics, branch restoration and `/lsp` selections. Only UI selection/notification and the two LSP session-entry types cross back to the host. Diagnostics entries use plain-text presentation. Settings reads use Pi's storage API without acquiring a write lock outside the jail; persistent global settings writes remain denied. Session-scoped enablement works. Source TypeScript is loaded with Node's built-in transformation hook, limited to the pinned package. No copied LSP mutation engine or unrestricted fallback is used.

LSP and local MCP connections reuse the process-group supervisor. JSON frames are limited to 8 MiB, total process output to 128 MiB and worker lifetime to 12 hours. Request cancellation/timeouts terminate the connection and process group, not merely the wait. A later explicit call can open a new connection; the canceled call is never replayed. Session navigation/shutdown closes connections. These are POSIX process-group guarantees, not containment of deliberately detached descendants.

`mcp` accepts local stdio servers from user-owned `<agent-dir>/mcp.json`, outside the writable workspace. Project definitions, symlinked config files, remote URLs, sampling and elicitation requests are not accepted. `/mcp` stops connections. The installer preserves this file. Example (replace the server path):

```json
{
  "servers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"],
      "network": false
    }
  }
}
```

Optional `env` contains string-valued server environment variables. `network: true` uses the managed proxy and existing host grants, never unrestricted networking. A remote MCP server cannot be confined by jailing its local client; remote transports are deliberately not advertised as supported.

Dunst is **not jailed**: Mac applications can write files or contact external services on its behalf. Each operation, including server startup, requires a fresh interactive human confirmation showing the exact tool and arguments. Reading already-loaded help schemas needs no new approval. Headless calls, refused/canceled approvals and approvals returned after a session change do not execute. Dunst's own risk approvals remain additional. Dunst is excluded from delegated capabilities and must never be used to bypass a sandbox denial.

`ci_watch` keeps only timers and notifications on the host. All Git/`gh`/`glab` queries run in fixed workers; stops and session transitions cancel pending starts and queries. Provider authentication must already be configured and usable inside the jail. `web_search` runs the existing Claude helper with hooks, skills and MCP disabled, writable state under private scratch, and read-only access to existing credential files. It consumes Claude quota only when explicitly requested. Live authenticated search has not been validated: the jailed `claude auth status` probe reported no usable login. Login/refresh failures remain errors; no host retry or new API key is introduced. Claude/GitLab API hosts outside the network baseline require explicit grants.

This is a tool execution boundary, **not a whole-Pi process jail**. Model transport, session persistence, background logs and trusted extension lifecycle handlers remain host-side. Do not load untrusted personal/CLI extensions or toolchains. Outside reads remain allowed, so this is not credential confidentiality isolation. Tests still need to run on a host where Codex can create its OS sandbox; an enclosing sandbox can prohibit nested namespaces.

### Network access

The global baseline automatically permits `github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `codeload.github.com` and `registry.npmjs.org`. Other registries, documentation sites and APIs require an additional host grant. This baseline applies to new sessions in every project after installation; it does not validate the projects themselves.

For a different persistent baseline, create the user-owned `<agent-dir>/network-policy.json` outside Pi. This replaces the defaults and is preserved by the installer:

```json
{
  "allow": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
  "deny": ["blocked.example.com"]
}
```

Only exact public DNS names are accepted, not URLs, ports, wildcards or IP literals. An explicit deny cannot be approved. Missing policy uses the defaults; malformed or symlinked policy fails closed. `{"allow":[]}` starts offline, with optional explicit host requests in interactive sessions. Project policy files are ignored.

The agent sees the current allowed hosts and can call `request_network_access` with `hosts` and `reason`. Already permitted hosts do not prompt. One affirmative human answer authorizes the new hosts for subsequent commands in the current workspace/Pi session. Duplicate requests share that grant; a refusal is not repeatedly prompted. Cancellation, session replacement, a new explicit deny or absent UI cannot become permission. Headless automation must use the global baseline. Grants live in private host-owned `<agent-dir>/network-grants/*.json` files and are removed on session shutdown/reload; a crash can leave inert files, which are never auto-loaded by a new Pi session.

Network access uses Codex's native managed proxy, not a home-grown proxy or a network-enabled shell outside the jail. It requires stable Codex >=0.155.1. Both the permission profile and `features.network_proxy=true` are supplied; the filesystem profile inherits Codex's protected metadata paths, keeps shared `/tmp` read-only and permits the private `TMPDIR`. Network-enabled commands also keep `.pi` read-only. Direct sockets to the host or outside network, upstream proxies, SOCKS, Unix-socket forwarding and local/private destinations are not enabled. Linux may allow loopback listeners inside the sandbox's isolated network namespace; this does not expose the host network. Clients must honor the injected HTTP(S) proxy variables; SSH and programs that ignore proxies will fail rather than bypass containment.

A host grant permits proxy traffic to that host, including uploads and authenticated writes; it is not a read-only or per-URL permission. Outside file reads are still allowed: do not treat a domain allowlist as data-loss prevention. Codex documents DNS-rebinding limitations; stronger destination-IP guarantees need a lower-level egress firewall. Running background commands keep their startup proxy policy. Stop them to revoke their existing access; grants only affect newly launched commands. No failed command is automatically retried because earlier steps may already have had effects.

Source: Codex [proxy policy](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/network-proxy/README.md) and [sandbox launcher](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/cli/src/debug_sandbox.rs). The real proxy test requires a host able to create Codex's OS sandbox and reach public HTTPS. It cannot be validated inside a runtime that prohibits nested sandboxing.

### Codex shell sandbox (macOS and Linux)

The installer deploys the executable launcher to `<agent-dir>/scripts/codex-shell.mjs` and sets `shellPath` to that absolute path. Restart Pi after installation. This adapter uses Pi >=0.99.1, the existing Codex CLI (>=0.155.1 for managed network access; earlier shell-only validation used macOS 0.146.0 and Linux 0.155.1), and Node >=22.19. It makes no model calls and does not require Codex authentication. The default binary is `~/.local/bin/codex`; a trusted launcher environment can set `PI_CODEX_SANDBOX_BIN` to another installed binary. A symlink at the default path can also point to a trusted package-manager installation.

- Native Bash, user `!` commands, and `@richardgill/pi-background-bash` use Pi's existing shell setting. Foreground/background execution, streaming, exit codes, timeouts and process-group cancellation remain owned by Pi/the background extension. No command-text rewriting or extra approval model is added.
- Codex applies macOS Seatbelt or Linux bubblewrap plus `no_new_privs`/seccomp to Bash and its descendants: writes are limited to the command's initial working directory and a private per-project `TMPDIR`; network access is restricted to allowed hosts through the managed proxy, or disabled when no hosts are allowed. `.git`, `.codex` and `.agents` remain protected by Codex. The directory is the session/worker cwd, not an inferred parent repository or all of `~/workspace`. The sandbox guard also rejects single, parallel and chained delegations whose canonical cwd escapes the parent's directory.
- Outside reads remain allowed. The strict dispatcher routes supported tools through their adapters and blocks unknown executors. Dunst is the explicitly confirmed host-side exception. Model transport and trusted extension internals remain outside the sandbox. Do not use another tool to bypass a denied action.
- `git commit`, `git push`, dependency downloads, local servers and Podman access can be blocked. A denial is an error, never permission to retry outside the sandbox. The adapter fails closed when the backend is missing, the platform is unsupported or launch fails.
- Linux requires a kernel/runtime that permits Codex's namespace-based sandbox. An unavailable sandbox is a launch failure, not permission to disable confinement. Fixed `/bin/cat` relays convert Node's captured Unix-socket stdio to pipes: otherwise Codex's network seccomp filter prevents libuv socket inspection and can silently discard Node console output. Only those fixed relays run outside confinement; the model's command remains a literal argument to Codex. Tests cover stdin, stdout, stderr, exit status and cancellation without relaxing network restrictions. Pi's native/background command paths use closed or ignored stdin. Persistent LSP/MCP transports own their input stream and terminate the supervised group on shutdown; an unmanaged caller leaving stdin open could otherwise retain the relay. No second sandbox backend or extra model process is added.
- Codex configuration is isolated under `~/.cache/pi-codex-sandbox/config`, with explicit filesystem/network overrides. Scratch files persist under a cwd-hashed directory in the same cache; they are not committed and have no automatic retention policy. The user's normal Codex profiles, credentials and saved allow rules are not loaded.
- For model Bash calls, project `shellPath` overrides are refused by `extensions/codex-sandbox` while this global adapter is enabled. Human `!` commands use Pi's resolved shell setting; do not override it in project settings. `/codex-sandbox` reports the shell configured at session load. Updating files does not retrofit an already running shell: reload idle sessions; existing jobs retain their original permissions.

Validate the actual installed backend and background extension without providers:

```sh
node --test --import ./tests/resolve-pi.mjs tests/codex-shell.test.mjs tests/codex-sandbox.integration.test.mjs tests/strict-sandbox.integration.test.mjs tests/codex-network.integration.test.mjs
```

Tests exercise project/temp writes, outside writes including symlinks and child processes, protected metadata, host-network isolation, proxy allow/deny decisions and host grants, preserved outside-read behavior, missing-backend refusal, native/background execution, peek/kill and deadlines. The Linux backend is documented in Codex [`linux-sandbox/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/linux-sandbox/src/lib.rs). The macOS implementation follows Codex [`exec_policy.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/exec_policy.rs) and [`seatbelt.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/sandboxing/src/seatbelt.rs); it invokes `codex sandbox` directly rather than importing execution-policy allow rules that can bypass confinement.

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
