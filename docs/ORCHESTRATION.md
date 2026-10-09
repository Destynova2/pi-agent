# Orchestration on large projects

This source branch adds confined Notes, Graphify, Git inspection, web helpers, CI queries, LSP and local MCP servers, plus delegation restricted to those executors. Dunst remains denied by the local strict dispatcher. The bounded Podman/clipboard/process bridge remains a distinct, human-approved host operation. Installing source changes does not activate existing sessions; authenticated live search and real configured language servers still need separate validation. Do not confuse fixture tests or source changes with activation in existing sessions.

## Working method

Completion guidance applies to ordinary requests, explicit `/orchestrate` requests and delegated tasks, even without the `subagent` tool. A first tested slice is a checkpoint, not completion of the whole request. Minimal implementation, including Ponytail mode, must preserve the requested scope. Plan-only requests and read-only audits remain limited to those deliverables.

For multi-part implementation, track every requested outcome and its acceptance check in the existing notes. Continue authorized, unblocked work after each slice; the parent owns integration and combined verification. Optional delegation being unavailable does not prevent direct work. Required review and permission gates remain blocking, while independent authorized work can continue. The final report must distinguish implemented, verified, awaiting human validation and genuinely blocked outcomes.

These are model instructions, not a completion detector. No automatic retry or extra model-turn loop is added. Tests verify instruction delivery and existing lifecycle behavior, not that a model will always finish a real project correctly.

- Start direct for simple or tightly coupled tasks. Deliver a first usable, tested slice before broad write delegation. Stabilize contracts before parallel work; use the existing sequential chain and `{previous}` handoff for dependencies. Integrate the first return directly rather than starting another correction round by default. Report scope growth or lack of a usable result before another long delegation.
- The model chooses the split from the request and observed code, without an extra planner call, fixed agent counts or file-count thresholds. This is automatic guidance, not a deterministic router or a guarantee of an optimal split.
- Give each worker the goal, relevant paths, allowed changes, constraints and acceptance check. Children have isolated context: they do not inherit the caller's conversation.
- Use disjoint write-sets or run dependent edits sequentially. The write-set remains an instruction, not a filesystem sandbox.
- Record checkpoints in shared notes: completed slice, files, check command and exit code, remaining requirements, blockers, next step. Re-read the worktree when resuming; notes are not proof or snapshots.
- Review the combined diff and run integration checks before claiming the full task is complete. Per-worker success does not establish cross-module correctness.

Scout and reviewer can read `note_list`; they cannot call `note_add` and no longer receive general `bash`. They use `git_inspect` for fixed-argument status, diffs, file lists and recent commits. Its helper-disabling flags reduce Git configuration hazards; execution also runs inside the Codex sandbox. Git must support `--no-lazy-fetch` (tested with 2.55.0); older versions fail explicitly rather than silently ignoring the protection. The notes extension only advertises tools that are active. At the first turn after startup or session navigation, it injects up to 20 recent project notes, capped at 12,000 characters, through the existing confined worker. The current ask is recorded afterward. Later turns do not repeat the history. Memory guidance remains present even without note tools: check permitted SQLite/session history before asking the user to repeat context. Notes are historical data, not fresh instructions or evidence of completion.

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

Native `bash` and the separate `bash_background`/`bash_process` tools share the confined launcher. Notes, including automatic prompt capture and inbox polling, and Graphify, including startup indexing and root discovery, now dispatch to fixed jailed workers. Notes alone receives additional grants for project note storage, its Git exclude entry and `~/workspace/notes.db` with SQLite sidecars, never the whole workspace directory. Linked storage is refused. Graphify caches live under the private cwd-specific `TMPDIR`; existing external caches are not deleted. Git inspection is offline; `web_fetch` uses the managed network proxy.

Routine calls need no approval. `request_network_access` can add exact public hosts, never filesystem permissions. `request_command_access` can rerun one failed foreground Bash command with human-approved additional write paths, still inside Codex. Unknown tools and executors not yet confined are denied. There is no unrestricted fallback. The legacy `tool-policy.json`, parser and shell classifier are removed; the installer backs up and deletes known legacy files. The dispatcher directory retains its name to replace the old installed entry point without loading two dispatchers.

Children inherit the intersection of role tools, active parent tools and the fixed confined-executor set, without recursive delegation, interactive network grants, `request_command_access`, `request_host_access`, `request_build_access`, `git_access`, `git_worktree_cleanup`, `jj_checkpoint` or `model_catalog`. Canonical child cwd must remain within its parent workspace in every mode, even with no policy file. Private session/report storage and model transport remain trusted host operations. Resumes can only narrow capabilities.

The installer sets `shellPath` and deploys the launchers, workers and SDK resolver. After a validated installation, restart with `pi --no-approve`; the [managed launcher](../INSTALLATION.md#plain-pi-startup-on-supported-runtimes) supplies that native flag automatically without editing Pi. Project resources are refused through `project_trust`; a session started with trusted project resources blocks permitted tools too. `/confined-tools` reports configuration, not proof that the backend can run. A missing adapter, changed cwd/shell or backend failure blocks execution.

The original LSP package stays installed at 0.4.4 with its extension filtered out (`extensions: []`). The replacement runs its actual lifecycle controller inside Codex: persistent servers, workspace previews/apply, diagnostics, branch restoration and `/lsp` selections. Only UI selection/notification and the two LSP session-entry types cross back to the host. Diagnostics entries use plain-text presentation. Settings reads use Pi's storage API without acquiring a write lock outside the jail; persistent global settings writes remain denied. Session-scoped enablement works. Source TypeScript is compiled natively when Node supports transform mode; otherwise it uses the installed Pi SDK's Jiti compiler, limited to the pinned package. Project Babel configuration and compiler disk caches are disabled; Node 26's removed TypeScript transform mode is not required. No copied LSP mutation engine or unrestricted fallback is used.

The installer also pins TypeScript 7.0.2 and binds the managed server to its absolute path under `<agent-dir>/npm/node_modules`, not project `npx` resolution. Default routing covers TS/TSX and JS/JSX/MJS/CJS, with `tsconfig.json`, `jsconfig.json`, `package.json` or `.git` as root markers. Only the exact old shipped TypeScript definition is migrated; custom definitions and explicit disablement are preserved. See [staged validation](../INSTALLATION.md#validate-before-activating).

LSP and local MCP connections reuse the process-group supervisor. JSON frames are limited to 8 MiB, total process output to 128 MiB and worker lifetime to 12 hours. Request cancellation/timeouts terminate the connection and process group, not merely the wait. A later explicit call can open a new connection; the canceled call is never replayed. Session navigation/shutdown closes connections. These are POSIX process-group guarantees, not containment of deliberately detached descendants.

**Codemode stays disabled by the strict dispatcher**, including Pi 1.0.0's lighter implementation. Its scripts have no validated confined executor here; enabling `defaultTools: ["+codemode"]` does not authorize them. Keep direct confined tool calls. Reconsider only after testing script execution, nested tool calls, cancellation and filesystem/network denials inside Codex.

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

Pi 1.0.4's global `pi mcp add/remove` commands also configure this adapter through the native `mcpServers` object. Both objects can coexist, with unique names across them. Run the CLI from an operator terminal; the confined agent cannot write its trusted global configuration:

```sh
pi mcp add playwright -- npx -y @playwright/mcp@0.0.83 --isolated
pi mcp remove playwright
```

After installing this adapter update, reload or restart Pi once. Later additions, changes, disablement and removals take effect at the next confined `mcp` tool call, without another reload. Changed or removed connections stop then; unchanged connections keep running. This is not a filesystem watcher: an idle connection remains open until the next call, `/mcp`, or session shutdown. List configured names with `mcp({})`, then discover tools with `mcp({server: "playwright", tool: "help"})`. Discovery starts only the requested server inside the jail.

Keep `-builtin:mcp` in settings. Registering `/mcp` replaces Pi's session MCP manager with connection cleanup and permission revocation. Native **`pi mcp list` can start servers outside this adapter**; use the confined tool above for discovery. Native remote/OAuth, project definitions (`--local`), custom `cwd`/`timeout`, `toolExposure` and non-default exposure modes are unsupported. Unsupported fields fail explicitly; default `codemode` registration still routes through this confined `mcp` tool, not the disabled Codemode executor. Native `type: "stdio"`, `enabled: false` and `description` are accepted. Arguments default to `[]`; environment values are literal strings, with no `${NAME}` or `!command` expansion.

Optional `env` contains string-valued server environment variables. `network: true` uses the managed proxy and existing host grants, never unrestricted networking. Native `mcpServers` definitions default to this managed network so `npx` can reach the npm registry; `network: false` disables it. Existing `servers` definitions remain offline by default. npm's cache lives under the launcher's private `TMPDIR`, and its lifecycle scripts are disabled through `npm_config_ignore_scripts=true`. Adding a package still authorizes execution of its server code; pin its version. Browser installation and navigation can require additional capabilities or host grants: successful tool discovery alone does not validate browser automation. A remote MCP server cannot be confined by jailing its local client; remote transports are deliberately not advertised as supported.

Dunst is **not jailed**: Mac applications can write files or contact external services on its behalf. The strict dispatcher therefore denies it in both parent and delegated sessions. Its separate implementation retains confirmation checks, but those checks do not turn host automation into a confined capability. `/dunst` only reports status or stops a connection. Do not advertise Dunst as functional inside this jail or use it to bypass a denial.

`ci_watch` keeps only timers and notifications on the host. All Git/`gh`/`glab` queries run in fixed workers; stops and session transitions cancel pending starts and queries. Provider authentication must already be configured and usable inside the jail. `web_search` runs the existing Claude helper with hooks, skills and MCP disabled, writable state under private scratch, and read-only access to existing credential files. It consumes Claude quota only when explicitly requested. Live authenticated search has not been validated: the jailed `claude auth status` probe reported no usable login. Login/refresh failures remain errors; no host retry or new API key is introduced. Claude/GitLab API hosts outside the network baseline require explicit grants.

`/orchestrate gates` also enters the installed Codex launcher, including when `PI_GATES_BIN` selects an alternative binary. Gate scratch and Prek caches remain in private `TMPDIR`; a failed launch never falls back to host execution. See [gate prerequisites](../INSTALLATION.md#gates-gatespi-prek-gatespi-orchestrategatespy).

This is a tool execution boundary, **not a whole-Pi process jail**. Model transport, session persistence, background logs and trusted extension lifecycle handlers remain host-side. Do not load untrusted personal/CLI extensions or toolchains. Outside reads remain allowed, so this is not credential confidentiality isolation. Tests still need to run on a host where Codex can create its OS sandbox; an enclosing sandbox can prohibit nested namespaces.

### User-supplied web URLs

A direct user message (interactive or RPC) authorizes `web_fetch` to read each
exact public HTTP(S) URL it contains, without an additional confirmation. `/web`
is also a direct read request. The permission lives only in this extension
session/workspace and is cleared by reload, navigation or shutdown. Child and
extension-generated input cannot create it; page contents cannot extend it.

The launcher selects a fixed GET worker, not a caller-supplied command. It allows
only the destination hostname for that process, keeps the existing filesystem
sandbox and private-network blocks, and respects explicit `network-policy.json`
denies. Credentials, custom ports, cookies, curl configuration, request bodies
and redirects are excluded. Path/query changes, including an appended `.json`,
do not inherit the user's URL permission. Existing baseline/approved hosts keep
their ordinary fetch behavior. No session grant file is created and subsequent
Bash commands keep their previous network permissions.

`request_network_access` remains a broader grant, including uploads; it should
not be used merely to read a user-supplied URL. HTTP 403 alone is not an
authentication diagnosis. A website, bot filter or proxy can reject a request;
report that distinction without automatically asking for credentials or wider
access. A successful HTTP read also does not prove that a JavaScript-only page
returned the article text.

### MCP and desktop consent

Eligible calls offer **Autoriser cette fois**, **Autoriser pour cette session**, **Toujours autoriser pour ce projet**, or **Refuser**. Refusal is the initial selection; Escape denies. A remembered grant applies to the scope displayed in that dialog, not to every operation of every server.

- **Dunst:** the displayed observation group covers perception and target attachment, including daemon startup, for all host windows. It can expose private applications outside the project. Clicks, typing, app launches, server risk approvals and unknown operations always require a fresh confirmation of the exact request. Cached help needs no new consent. No Dunst grant enables headless or delegated use.
- **MCP:** consent is per configured server and named tool. `readOnlyHint: true` without `destructiveHint: true` offers remembered consent, for all arguments to that tool. These hints are unverified server claims, **not an enforced read-only sandbox**. The configured [isolated Playwright profile](BROWSER-MCP.md) also offers remembered consent for interactions and JavaScript, explicitly covering site modifications and data transfers. Sensitive tools on other servers require fresh exact confirmation. Remembered consent does not authorize sending messages or submitting forms without the user's request. Trusted private stdio definitions already authorize jailed startup and discovery, which do not prompt.

Session grants are memory-only and cleared on session navigation, stop, reload or shutdown. They are not inherited by another process. Project grants persist under private `<agent-dir>/mcp-approvals/`, outside the writable workspace, as hashes without request arguments or credentials. Scope is the canonical working directory, not its parent repository or all projects. Confined headless MCP calls may consume an existing matching read-only project grant; they cannot create one. Sensitive browser tools and Dunst always require interactive UI.

MCP grants bind the server definition (including configured arguments, environment/network settings), resolved executable metadata and discovered tool declaration. Dunst binds its fixed observation list and executable identity. Changed identities need new consent; a changed declaration during approval fails before dispatch rather than replaying automatically. This fingerprints configuration, not script contents or transitive dependencies, and does not attest a server's behavior. Mutable data files passed as arguments do not invalidate consent when their contents change. File and network sandbox rights remain unchanged.

Use `/dunst permissions` to revoke Dunst consent for the current project. Use `/mcp permissions [server]` to select a configured server and revoke its project consent; an explicit name also works after that server was removed. Both require interactive confirmation, clear local session consent and stop local connections. Revocation invalidates matching grants and pending approvals in other Pi processes before their next dispatch; it does not undo completed or already-dispatched actions. Refused requests do not repeatedly prompt until session reset or revocation. New sessions never silently acquire a broader grant.

### One-command filesystem access

After a foreground `bash` call fails, its result can offer `request_command_access`. Pass the returned `failed_call_id`, `write_paths` (1–8 canonical absolute paths) and `reason`. The tool retrieves the original command and cwd from memory; the model cannot replace them. An error is not automatically classified as a sandbox denial: first identify the missing access and inspect partial effects.

The confirmation shows the complete command, cwd, additional paths and reason. Approval reruns the **entire** command once, including steps that may already have succeeded. Directories authorize their contents, not just one named operation. Existing workspace/temp rights and the current network policy remain in effect; no network permission is added. The retry has a 60-second deadline and a 1 MiB combined output limit; inline output is capped at 60,000 characters. The shared supervisor cancels its process group on abort or session navigation.

Requests expire five minutes after failure. Each ID is consumed once, including refusal or validation failure. Arguments are snapshotted before waiting; paths and session state are rechecked after confirmation and paths are checked again by the launcher. No UI, inactive capability, cancellation, stale cwd, session switch/fork/tree navigation or shutdown means no execution. Approvals are not saved, inherited by subagents or reused by subsequent commands. Background jobs, user `!` commands, nested tool calls and commands longer than 2,000 characters are not eligible; nothing is automatically replayed.

Workspace ancestors, sandbox runtime/configuration storage, links and special-file targets are refused. Ordinary outside files or directories may be granted; a directory's existing contents are not snapshotted. Host changes between attempts can still change what a command does. The launcher uses native Codex write roots or filesystem-profile entries, never `sudo`, `danger-full-access`, an unrestricted retry or a shell command classifier.

**Known limitation: `pi --list-models` is not fixed by this feature.** Pi 0.99.1 acquires directory locks for settings, auth and its model store even when listing. Codex 0.155.1 deliberately prevents deletion/renaming of a writable directory root, so granting the individual `.lock` roots permits creation but prevents release. Granting all of `~/.pi/agent` would expose executable extensions and credentials. Runtime locks therefore remain ungrantable; use a separate read-only listing implementation rather than widening that directory. Use `model_catalog` in the parent: it reads the current registry snapshots without starting another Pi, refreshing catalogs or resolving credentials. `provider`, `availableOnly` (default true) and `limit` (default 200, maximum 1000) filter its metadata-only result. Cached availability does not establish valid credentials or remaining quota. The CLI itself remains unchanged. This limitation is covered by real Codex tests, including an isolated Pi CLI invocation without credentials or provider calls. The new approval flow was validated on macOS with Codex 0.155.1; it has not been rerun on Linux.

Codex reference: [directory-root protection](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/sandboxing/src/seatbelt.rs). Its [tool orchestrator](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/orchestrator.rs) separates approval from process execution; this bridge follows that pattern without embedding another model session.

### Git operation consent

Use `git_access` directly for an authorized Git write. It does not require a previous failed Bash call. `request_command_access` eligibility is a separate, short-lived record of a foreground failure; a missing record is not a human refusal and does not justify repeating the same denied command or using Dunst.

Local operations offer **Refuser**, **Autoriser cette fois**, **Autoriser pour cette session**, and **Toujours autoriser pour ce projet**. A remembered local grant covers all three operations below, including future arguments, for the canonical repository root and its metadata identity. Changing from `branch` to `stage` to `commit` does not ask again. Project grants survive Pi restarts; session grants do not. Subdirectories of the same worktree share the repository scope; linked worktrees have separate identities. No grant authorizes a commit or publication that the user did not request.

| Operation | Fields besides `operation` and `reason` | Scope |
|---|---|---|
| `branch` | `branch` | Create and switch to a new branch from current HEAD; never reset or overwrite an existing branch |
| `stage` | `paths` | 1–1000 explicit repository-relative regular files or tracked deletions; literal paths, never directories, wildcard expansion or all files |
| `commit` | `paths`, `message` | Commit the existing index only when its complete path list matches the supplied list; does not stage other files or finish an in-progress merge, rebase or cherry-pick |
| `push` | `remote`, `branch` | Publish the reviewed commit ID to one configured HTTPS destination and branch; fresh exact consent every time |

Push cannot use saved local consent. The dialog includes the resolved destination and immutable commit ID. Force, mirror, tags, custom VCS helpers, configured push options, SSH/local transports, embedded URL credentials and upstream-configuration changes are excluded. The existing public-host allowlist still applies; another host needs `request_network_access`. Existing credentials must work inside the jail; there is no authentication or host-execution fallback.

Git must support `git hook run --to-stdin` (verified with the installed Git); an unsupported version fails without bypassing hooks. The fixed worker runs in Codex with operation-specific Git data paths (index/lock, objects, local refs and logs as needed), not writable Git config/hooks, the whole `.git` directory, or a general shell grant. Ordinary Bash remains unchanged. Hooks, filters, signing and checks remain enabled and confined. Automatic maintenance and the filesystem-monitor helper are disabled for this bounded operation, not in repository configuration. A hook requiring unavailable writes or services fails rather than being bypassed. Execution is bounded to five minutes; helpers' raw diagnostics are withheld because they may contain secrets.

Requests are copied before prompting. Repository identity, HEAD, index, effective configuration and selected file contents are checked again after consent and by the execution worker. Named file reads are bounded to 32 MiB each; symlinks, hardlinks and submodule directories are refused. These checks are not an atomic transaction spanning other Git processes: avoid concurrent Git writers. Immutable runtime wrappers chain the original commit hooks, preserving arguments, stdin, message edits, post-index and reference-transaction hooks. Index-changing pre-commit/message hooks reject the commit; a reference-transaction gate also checks the reviewed tree and old HEAD before history changes. Hook effects on files or the index remain for inspection, not automatic rollback. Hooks share the operation's Git data permissions; this is not a claim that arbitrary repository code is harmless. A post-commit hook or another writer can still change state afterward; any observed tree mismatch is reported and must be inspected before a push. A timeout or failure can leave effects, including an already-created commit. Never automatically retry it.

`/git-access permissions` revokes local and project consent and clears refused requests for the repository. It also works when Git configuration is broken. It does not undo completed actions. Revocation in another Pi instance invalidates pending tickets before dispatch. New sessions and replaced repositories cannot silently obtain broader consent. Long approval dialogs show the full request across pages before exposing approval choices; Escape refuses. An already-matching grant does not require a dialog. Requests remain bounded to 256 KiB and 1000 explicit paths.

For linked-worktree cleanup, use the separate parent-only `git_worktree_cleanup` capability. It inspects without approval, then requests exact one-time consent to archive selected directories or prune selected missing registrations. Branches, files and HEAD commits remain recoverable; no push-or-discard decision is needed just to retire a worktree. See [worktree cleanup, archives and recovery](GIT-WORKTREES.md).

Before installing this executor, run its native boundary gate from an operator shell where Codex can create a sandbox:

```sh
node --test --import ./tests/resolve-pi.mjs tests/git-access.test.mjs tests/git-access.integration.test.mjs
```

The unit/fixture tests exercise real Git in disposable repositories and mocked consent. The integration test separately verifies that approved Git works, ordinary Git writes remain denied, and hooks cannot write Git configuration or outside files. No real push, credentials, provider call or production repository is used. A nested-sandbox refusal is a validation blocker, not a passing or silently skipped test. Do not activate the executor until this gate passes on the target host.

#### Linux Git transactions

Linux bind mounts cannot atomically replace an individually mounted Git index or create its lock file beneath a read-only parent. On Linux, the approved parent broker therefore snapshots bounded Git metadata into a private temporary directory. Git, filters and hooks execute inside Codex against that copy. Existing objects are read from the original object pool; new objects stay in the temporary pool. The real Git directory remains read-only to the worker, as do configuration and hooks in both copies. Ordinary Bash receives no extra access.

After successful execution, the parent validates every changed metadata path against the exact operation and branch, checks new object hashes, acquires exclusive native Git lockfiles and rejects concurrent metadata changes. It then writes only approved data and removes its own locks and temporary copy. It never executes Git outside Codex. Unapproved paths, symlinks, hardlinks, existing locks and metadata over 128 MiB or 20,000 files fail explicitly. Object publication currently accepts loose objects; unsupported pack output is refused.

A failure or cancellation does not trigger another Git command. Hook effects in the working tree, a completed remote push or a partial write-back can remain; inspect the reported state before any new operation. This transaction path supports ordinary repositories and linked worktrees. Other platforms retain direct confined Git execution.

### Local jj recovery points

Before a new authorized modification task, the agent's instructions call for
`jj_checkpoint({ reason: "before ..." })`. Continuations reuse that checkpoint;
another requested risky phase can take a new one. Read-only audits do not initialize
or snapshot repositories. These are agent instructions, not an automatic hook that
can infer user intent or guarantee the model calls a tool before every edit.

The parent-only capability initializes an ordinary colocated jj workspace once,
creating a Git repository first if the directory is not versioned. Subsequent calls
snapshot the existing workspace. Initialization requires one-time consent. After
initialization, snapshot consent can be saved for the session or project, separately
from `git_access` consent. `/jj-checkpoint permissions` revokes it. Missing jj is an
explicit prerequisite, never an automatic installation; the current fixture gate
uses jj 0.45.1. Children, inactive tools, headless sessions, expired approvals,
session changes and refusal cannot dispatch the worker.

Git and jj run offline inside Codex against a bounded disposable copy. The parent
publishes validated new Git objects, jj retention references and jj data only.
Existing Git configuration, hooks, branches, index and working files are preserved.
Existing objects are read-only inputs through a temporary Git alternate pool;
they are not recopied or subject to the copy limit. The alternate pointer is never
published. New objects must pass the same content-hash validation before publication.
Each result also has a private `refs/pi/checkpoints/<operationId>` Git reference
that retains its file contents independently of jj's operation retention, without
creating a branch. These local pins are not automatically deleted or pushed.
The resulting commit tree is checked against the selected files' exact contents,
types and executable bits. Working-file symbolic links retain their literal target
without following it, including external and dangling targets. A file silently omitted by jj's size or auto-track settings
fails the checkpoint. The returned full `operationId` and `commitId` belong in the
task checkpoint together with `gitRef`, not just a shortened revision in a note.

This records tracked files and new nonignored files, including dirty changes made
before the task. It excludes ignored untracked files and external state. It is a
local recovery point, not a remote backup or an exact backup of Git's staging split.
Files can be recovered from the full commit ID; restoring an operation can also
change repository history and bookmarks. Either restoration requires a separate
explicit user request and inspection of the current changes first. The tool cannot
restore, push or run arbitrary commands.

The main repository may have linked worktrees. Their registrations, files, HEADs,
indexes and locks are excluded from the disposable copy and left unchanged. This
checkpoint backs up only the main worktree; it does not back up the linked ones.
Running the tool from a linked worktree itself remains unsupported: run it from
the main repository for a main-worktree checkpoint. Bare/noncolocated repositories,
source alternate pools, submodules, unfinished main-worktree Git operations,
sparse checkouts, metadata symlinks, linked parent directories, hardlinks and
special files are refused.
Copied metadata (including new Git objects) and selected working files each have
a 128 MiB total limit, 20,000 entries and 64 MiB per file. Unsupported metadata
layouts fail explicitly.
Avoid concurrent Git/jj writers: source revalidation and exclusive Git lockfiles
do not provide an atomic transaction across independent jj processes. Publication
errors can leave partial metadata; inspect it without an automatic retry.

Before activating this capability, run the fixture and native boundary gates with
the installed SDK selected by `PI_PACKAGE_JSON`:

```sh
node --test --import ./tests/resolve-pi.mjs tests/jj-checkpoint.test.mjs tests/jj-checkpoint-access.test.mjs tests/jj-checkpoint.integration.test.mjs
```

The fixtures perform real snapshot/recovery in disposable repositories. The native
gate separately proves sandbox availability, initialization, repeated snapshots,
preservation of eight linked worktrees, read-only access to existing Git objects
and continued denial of ordinary Bash Git writes. An unavailable host sandbox is
a blocker, not a passing gate. See the [jj snapshot and operation reference](https://docs.jj-vcs.dev/latest/cli-reference/).

### One host operation

`request_host_access` offers **Refuser** first and **Autoriser cette fois** only. This is an explicit host capability, not an extra public network host: Podman can change containers and host resources beyond the writable workspace. Bash keeps its original sandbox, and no host grants persist or reach subagents. Never use Dunst or an arbitrary shell to work around a denial.

Every request includes `operation` and a short `reason`, without secret values:

| Operation | Additional fields | Result or effect |
|---|---|---|
| `podman_list` | None | IDs, names, states and ports only |
| `podman_inspect` | `target` container name/ID | Limited state/ports, environment key names, HTTP(S) origins from `*_PUBLIC_URL`, booleans from `*_FALLBACK`; no raw inspect data |
| `podman_logs` | `target`, optional `tail` (1–500, default 100) | Last hour, no follow, stdout and stderr; terminal controls escaped. Application secrets may appear, as stated in the approval |
| `podman_machine_list` | None | Validated VM name, running state, CPU count and memory; no SSH identity paths |
| `podman_command` | `args` | Only `[start|stop|restart, container]` or `[kube, play|down, manifest]`; `play` also accepts `--replace` before the manifest |
| `clipboard_env` | `file`, `key` | Copy one dotenv value from a regular project file to the macOS clipboard |
| `clipboard_container_env` | `target`, `key` | Copy one container environment value directly to the macOS clipboard |
| `process_info` | `pid` | PID, parent PID and executable name; no argv or environment |

Podman management output is withheld because it can contain secrets. A zero exit code is not proof of application health: perform the relevant acceptance check afterward. Clipboard values are never returned in tool output, approval text or automatic incident notes. They remain exposed to the host clipboard and clipboard history. Copying a value does **not** authorize login, form submission or message sending; the human still controls that action. No application authentication or origin check is disabled.

The request is snapshotted, limited to 2,000 bytes and expires after five minutes. Exact arguments use compact JSON. A dialog that cannot show the complete request and both choices is rejected before prompting: shorten the reason/arguments or enlarge the terminal, rather than approving truncated text. Current workspace, capability, cancellation and executable metadata are rechecked before dispatch. Project dotenv files (64 KiB maximum) and Kubernetes manifests (1 MiB maximum) are read as bounded regular, single-link files and content-checked again after consent. This is not a security review of manifest contents or Podman's transitive configuration. Podman uses the current user's configured connection; the grant can affect that remote service. Executable lookup uses fixed system/Homebrew directories, or the trusted operator's `PI_PODMAN_BIN`, never a workspace executable.

Execution uses the existing supervisor without a shell, with a 60-second total deadline and 1 MiB per-process output ceiling. There is no automatic replay. Canceling the CLI cannot undo container changes or a clipboard write already performed. Session transitions cancel pending operations; `/host-access reset` clears pending consent and locally cached refusals. It grants nothing. Linux clipboard transfer is unsupported; the new approval flow is tested on macOS, not validated on Linux.

### KVM image builds

For an authorized Packer/Ansible image build, `request_build_access` runs the fixed command `ansible-playbook -i localhost, ansible/build.yml` in the current Linux project. Inspect `ansible/build.yml`, `packer/`, `config/` and `ansible.cfg` before requesting it. The only parameters are `reason` and an optional `timeout_minutes` (default 120, maximum 240). No preceding failed Bash call is required.

The interactive parent asks **Refuser / Autoriser cette fois** for each build. The approval identifies the project, executable, source digest, deadline and capabilities. Source changes during approval cancel execution. The digest covers `ansible/`, `packer/`, `config/` and `ansible.cfg`, not cached dependencies or the whole installed toolchain. These sources must be bounded regular files without links. Project code and cached dependencies are executable build inputs, not independently attested software.

The build uses `/usr/bin/bwrap` directly with isolated user/process/mount namespaces, dropped capabilities, disabled nested user namespaces, a read-only root and a minimal `/dev` plus **only `/dev/kvm`**. Only the project's `.cache/`, `output/` and private temporary directory are writable. Project sources and root metadata remain read-only. The runtime and launcher must be outside the project. The ordinary Codex launcher and its policy do not change.

This capability explicitly grants the **full native host network**, including local services, TCP/UDP and Unix sockets. This is necessary for the guest's Nexus access and Packer/Ansible SSH connections; it is broader than one allowed public host. Build code can reach host services, whose APIs may themselves have effects outside the writable directories. No credentials or proxy environment are inherited by the launcher; existing host files remain readable under the same outside-read policy as ordinary tools. The prompt describes these permissions before execution.

The host must provide accessible KVM, Bubblewrap supporting `--disable-userns`, `/usr/bin/python3` and the project's installed Ansible/Packer/QEMU dependencies. A host metadata/access check precedes approval. Inside the actual sandbox, isolated Python verifies the KVM API and creates/closes an empty VM before Ansible starts. Missing `/dev/kvm` in ordinary Bash does not establish that it is absent on the host. No automatic `chmod`, group change, module load, unconfined fallback or replay is attempted.

Execution remains in the foreground under the existing process-group supervisor. Progress updates report pending execution; completion is not announced early. Output is capped at 32 MiB and kept in a private log under the host's `$TMPDIR`, outside the build's writable scratch directory. Session navigation, cancellation and `/build-access reset` stop the process tree; reset also clears refusals. Existing artifacts and logs are retained for inspection. Consent is recorded in the permission audit and start/completion/failure in `kvm_build` session entries. A zero exit status still requires validation of the delivered image.

Install the updated configuration through the normal staged installer and restart Pi. No separate Codex rebuild is needed. Native validation requires a Linux host with accessible KVM:

```bash
node --import ./tests/resolve-pi.mjs --test tests/build-sandbox.integration.test.mjs
npm run verify:integration
```

Use the installed SDK's `PI_PACKAGE_JSON` and the integration prerequisites from `INSTALLATION.md`. The native test creates a VM, reaches a synthetic local HTTP service and verifies allowed/denied writes. It does not run a real RHEL build or establish image correctness. A missing native prerequisite fails the test; it is never treated as a successful sandbox check.

KVM incidents now identify this supported capability. For other capability gaps, record the precise missing operation and prepare a reviewed source change with regression checks. This workflow does not grant the agent permission to modify the active harness or approve its own permissions.

### Requirement checkpoints and autonomy

For a multi-part request, the parent uses `task_checkpoint` to retain every outcome and acceptance check. `/task-status` displays the checklist. Updates merge by stable ID: omitting installation or validation from a later update does not erase it. Completed items require evidence; blocked or deferred items require a reason and next action. Replacing unfinished work requires recording the user's explicit scope change.

Checkpoints use Pi's native session entries, scoped to the current conversation branch. The `context` handler restores the latest state before each model call, including after restart, compaction, fork or tree navigation. This is trusted session metadata, not arbitrary filesystem execution, and the tool is not delegated. It does not add model calls, auto-continue canceled tasks, grant permissions, or prove the model's reported result. The agent must still reconcile the checklist with real checks. Existing authorization covers the necessary work; actual capability gates still require their own approval.

### Ordinary GPU denial and the optional Metal capability

The Metal capability is limited to macOS on Apple Silicon. Other platforms are rejected before backend configuration is read. Linux GPU access requires a separate backend and native confinement qualification; it is not implemented by the Linux shell sandbox or this Metal adapter.

On the Mac, stock Codex CLI 0.160.0 compiles `tests/fixtures/metal-probe.swift` inside its sandbox, but execution returns `METAL_UNAVAILABLE` (exit 77). `tests/metal-baseline.integration.test.mjs` verifies this negative baseline twice. It is **not** a passing GPU acceptance test. Ordinary Bash keeps this restriction even when the optional backend is installed.

Native diagnosis on 2026-10-04 confirmed the hardware supports Metal (Apple M5 Max, macOS 26.5.1). `codex sandbox --log-denials` recorded denied `IOSurfaceRootUserClient` and `AGXDeviceUserClient` opens. The failure is at `MTLCreateSystemDefaultDevice()`, before shader compilation or GPU submission. See [the captured denial and its limits](DEBUGGING.md#native-metal-diagnosis-on-codex-01600). Additional filesystem roots and network grants cannot authorize these IOKit operations.

The [experimental Metal backend](../experiments/metal/README.md) adds a separately qualified, digest-bound capability through `request_command_access` with `gpu: "metal"`. Its native qualification covers a successful compute result `[2,4,6,8]`, simultaneous file/network denial, ordinary-command isolation, timeout, cancellation and result journaling. Installation remains separate from the normal configuration installer; an absent or invalid qualification fails closed. There is no generic `request_gpu_access` or unconfined `host_command` fallback. A nil device in ordinary Bash does not test the approved one-command backend; see [the installed capability and its validation](DEBUGGING.md#installed-one-command-metal-capability).

GPU-only requests offer once, session or project consent, bound to the canonical
working directory and qualified backend digest. Saved consent skips further
prompts and model reviews for eligible Metal commands. Each command still needs
its exact captured foreground failure, expires after five minutes and runs once
for at most 60 seconds. Additional `write_paths` always retain exact one-time
approval. No grant enables ordinary Bash GPU access, headless use or delegation.
`/command-access permissions` revokes Metal consent for this project;
`/command-access reset` clears session grants and refusals while preserving project
grants. Both cancel this session's pending or running approved commands.

### Incident records

Recognized failed tool diagnostics and provider errors create sanitized `blocker` notes through the existing confined Notes worker. Records include an incident ID, observed category, open/reopened state, evidence type and a next step. They do not include raw commands, arguments, error text, credential values or provider headers. A diagnostic category is a lead, **not a verified root cause**.

Identical failures are deduplicated within a bounded, 256-entry session cache. A successful result for the same invocation (or provider/model) creates a `done` record with `status=recovered`; a different command succeeding does not close it. Recovery of a call is not acceptance of the whole task. Session restart clears correlation, not persisted notes. Read recent incidents with `note_list` filtered by `blocker` or `done`; record verified causes, acceptance results and reusable fixes with the existing `lesson` notes. Tool-result hints discourage unchanged retries but are not a deterministic retry blocker.

The journal shares Notes' project database and central mirror. Persistence failure is reported without an unrestricted storage fallback. It does not silently change code, permissions, models or provider accounts, and adds no model calls. This is diagnostic memory for subsequent work, not automatic self-training or proof that an application was repaired.

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

The installer deploys the executable launcher to `<agent-dir>/packages/pi-agent-config/scripts/codex-shell.mjs` and sets `shellPath` to that absolute path. Restart Pi after installation. This adapter uses Pi >=1.0.4, Codex >=0.155.1 for managed network access, and Node >=22.19. It makes no model calls and does not require Codex authentication. On Linux it prefers the private backend at `~/.local/share/pi-codex/0.155.1-file-roots/codex` when installed, then falls back to `~/.local/bin/codex`. Exact file grants require the [Linux backend repair](../patches/codex-linux-file-roots.md). A trusted launcher environment can set `PI_CODEX_SANDBOX_BIN` to another installed binary. A symlink at the default path can also point to a trusted package-manager installation. Workers receive `PI_CONFINED=1` from the command launched inside Codex; OS confinement enforces permissions. Linux does not provide the macOS-specific `CODEX_SANDBOX=seatbelt` marker.

- Native `bash`, user `!` commands and the public background factory use Pi's existing shell setting. `bash_background` starts an explicit background operation; `bash_process` controls it and completion notifications retain its exit status. Foreground-to-background timeout handoff is not exposed. Streaming, timeouts and process cleanup remain owned by Pi/the background package. No command-text rewriting or extra approval model is added. The separate `request_command_access` tool handles explicitly confirmed foreground retries.
- Codex applies macOS Seatbelt or Linux bubblewrap plus `no_new_privs`/seccomp to Bash and its descendants: ordinary writes are limited to the command's initial working directory and a private per-project `TMPDIR`, with explicit additional paths only for an approved one-shot retry; network access is restricted to allowed hosts through the managed proxy, or disabled when no hosts are allowed. `.git`, `.codex` and `.agents` remain protected for ordinary Bash. The separately approved `git_access` operation changes only its approved Git data; Linux uses the metadata transaction described above. The directory is the session/worker cwd, not an inferred parent repository or all of `~/workspace`. The sandbox guard also rejects single, parallel and chained delegations whose canonical cwd escapes the parent's directory.
- Outside reads remain allowed. The strict dispatcher routes supported tools through their adapters and blocks unknown executors. Dunst remains denied by the local strict dispatcher; `request_host_access` is an explicitly confirmed host-side exception; `model_catalog` only reads in-memory registry snapshots. Model transport and trusted extension internals remain outside the sandbox. Do not use another tool to bypass a denied action.
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

The subagent extension keeps dispatch and child lifecycle in `index.ts`, its result contract and bounded handoff text in `results.ts`, and native UI rendering in `render.ts`. Rendering consumes results without starting children or changing session state.

Offline subprocess tests cover large task/file transport, a 1.2 MB UTF-8 report and chain handoff, cancellation, deadlines, signal/nonzero exits, incomplete answers, mixed parallel outcomes, bounded UI history, native resume ownership/locking/corruption and permission narrowing. Deterministic real-Pi CLI tests verify denied tools never execute, protected paths, downstream argument mutation and the authoritative subagent error flag without network or provider credentials. Git tests use hostile local helpers and a promisor remote sentinel. Shared-supervisor tests cover streaming, output limits, callback failure and descendant cleanup. These tests establish harness behavior, not end-to-end project completion quality. That requires representative multi-module tasks and observation of the model's actual decisions.
