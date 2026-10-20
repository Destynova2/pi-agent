# Generic execution capabilities

Status: the generic `execution` tool is implemented in source for bounded
foreground commands and session jobs on Linux. This document also describes the
remaining target architecture. A separate `request_http_access` capability provides
reviewed API GETs with dotenv credential references. Credentials cannot be passed
to arbitrary `execution` commands. Leased services and devices remain unimplemented.
The RKE2 incident is a use case, not the name of a new privileged tool.

## Available now

Load `execution` with `load_tools`, then call `action: "capabilities"` for the
supported combinations. Every `run` receives fresh task review without a human
dialog or a failed Bash prerequisite. Explicit manual policy and network denies
remain binding. `status` and `stop` accept only a job owned by this parent session.

```json
{
  "action": "run",
  "command": "make check",
  "reason": "Run the requested checks and write their cache",
  "write_paths": ["/absolute/project-cache"],
  "hosts": ["registry.npmjs.org"],
  "timeout_ms": 120000,
  "background": true
}
```

The `workspace` profile composes exact write paths and public DNS hosts, including
in a separately reviewed canonical sibling `cwd`. Empty `hosts` means offline,
even if the session normally permits networking. Existing metadata paths are excluded from the working directory and additional
write roots, including existing nested repositories. Executable selectors, runtime
storage, PATH directories and host startup/configuration files cannot become extra
write roots. Extra roots must already exist. A changed device/inode/canonical path
invalidates the review, including launcher checks after chdir and before exec.
The reviewed binding also includes the metadata exclusion digest. Within a session,
pending and running requests reserve their roots exclusively, including equal paths.
A native `flock` supervisor in protected agent storage serializes workspace execution
across sessions sharing that installation; a busy lock refuses dispatch. Isolated
copies can run concurrently. The exact launcher payload is bounded before review.

The workspace profile retains the ordinary sandbox's host filesystem reads.
Its environment is reduced to PATH, HOME, locale, terminal, timezone, temporary
storage and protected backend/agent selectors; provider tokens and socket-agent
variables are not forwarded. This is not secret isolation: readable files may
contain credentials, and allowed hosts can receive arbitrary data. Input files
remain live. Choose isolated copies when confidential host reads are unacceptable.

Identity checks do not make the host path-to-mount transition atomic. The current
adapter assumes trusted host-side mutation during that transition; it is not
qualified against an adversarial concurrent host process or an unrelated executor
that does not participate in the installation lock. Existing metadata is mount-protected on Linux; the
scan is not a blanket ban on creating metadata in newly created directories.

Use `profile: "isolated"` with explicit `inputs` and optional installed `binaries`
for disposable offline copies with private Unix IPC and a clean environment.
Network and host-write additions are refused for that profile. The two profiles
never fall back to each other or to an unrestricted host shell after failure.

Durations are 1–120 seconds. At most four requests or jobs are active concurrently, with one workspace process
per agent installation; output is
bounded and completed handles are retained in a bounded session history. Jobs
survive their initiating tool call but end on session change/shutdown, explicit
stop or deadline. Native Linux tests check cancellation of a truly detached child
for both profiles. The generic entry point is Linux-only pending native macOS qualification of
metadata protection and process ownership. Existing macOS tools remain available.
Completion notifications carry only the job ID and state; retrieve untrusted output
through `status`. Completion is not application readiness. Recheck effects before any retry.

Implementation: [planner](../lib/execution-plan.ts),
[broker](../extensions/tool-policy/execution.ts),
[launcher](../scripts/codex-shell.mjs),
[regressions](../tests/execution.test.mjs) and
[native checks](../tests/execution.integration.test.mjs).
Existing capability tools remain compatible; their manual consent contracts are
unchanged. `git_access` retains its separate semantic and metadata protections.

## Local and private API inspection

Load `request_http_access` with `load_tools` when the task needs one API GET on a
local/private service or credentials already stored in a dotenv file. It performs
one host-side request after approval of the exact URL, credential reference and
returned fields. The existing `/approvals` policy can review each call automatically;
otherwise the interactive parent confirms it. Headless use requires a configured
automatic policy. Allows are never remembered or delegated to subagents.

For a Nexus inventory, replace the example port, canonical file path and key with
the service's actual configuration. Supply the reference, never the password:

```json
{
  "url": "http://127.0.0.1:8081/service/rest/v1/repositories",
  "reason": "Inspect the requested Nexus repository inventory",
  "auth": {
    "kind": "basic",
    "username": "admin",
    "file": "/absolute/service/config/.env",
    "key": "NEXUS_ADMIN_PASSWORD"
  },
  "fields": ["name", "format", "type", "attributes.proxy.remoteUrl"]
}
```

HTTPS is required except for `localhost`, `127.0.0.1` and `::1`. Certificate
verification stays enabled. DNS is resolved once and the connection uses that
address with the original Host/TLS identity; `localhost` must resolve to loopback
for HTTP. The client does not use a proxy, follow redirects, reuse a session,
accept arbitrary headers/cookies or issue other HTTP methods. URLs cannot contain
credentials, query strings, fragments or a terminal DNS dot. Existing explicit network denies apply;
the capability creates no general network or shell grant and does not bypass an
outer sandbox denial.

Basic and Bearer authentication accept one key in a regular dotenv file of at most
64 KiB. An exact file outside the project can be reviewed. Symlinks, hard links,
runtime storage and protected credential directories are refused. Only metadata
is read before approval; changed file identity, network policy, session, tool
availability or approval invalidates dispatch. This is not a vault: the host
extension necessarily holds the credential while sending the request.

With no `fields`, only status and request metadata return. With `fields`, successful
JSON responses expose up to 12 scalar dot paths per object, at most 2,000 objects,
512 characters per string and 256 KiB of projected output. Nested objects and
missing fields become `null`; unselected data, headers and raw errors stay withheld.
Referenced credentials and common encodings are masked. This is not general
secret detection: select known metadata fields, not arbitrary sensitive content.
The deadline is 30 seconds including DNS, and response bodies are capped at 1 MiB.
Cancellation releases the request; an already pending system DNS lookup may finish
later without dispatching HTTP. `/http-access reset` cancels pending inspections
and clears human refusal memory. Explicit policy denials remain binding.

For the Nexus migration case:

- A public command failing with proxy `CONNECT 403` has not received a Nexus
  response. Use `request_network_access` for a separately reviewed exact command
  and public host; preserve explicit refusals and report unavailable transport.
- The [repositories API](https://help.sonatype.com/en/repositories-api.html) lists
  only repositories visible to the authenticated identity. Missing results alone
  do not establish that Quay is absent from the external instance.
- To check a password, use a GET endpoint documented by the running service as
  requiring the intended permission, with the body withheld. A successful
  anonymous endpoint proves nothing. `authenticatedRequest` means credentials
  were sent; `authenticationVerified: false` means the transport made no
  authentication judgment. HTTP 401/403 differ from proxy CONNECT failures.
- Inspect the existing state and an OpenTofu plan before replacing a pod. An
  existing container worker can run the exact plan through `request_podman_access`
  after its own review. Plans may refresh state or contact providers; their effects
  remain part of that review. A probe does not authorize apply, service replacement
  or deletion. Configuration alone verifies neither migration nor a real cache pull.

Implementation: [HTTP broker](../extensions/tool-policy/http-access.ts),
[credential reader and transport](../lib/http-inspection.ts),
[approval regressions](../tests/http-access.test.mjs) and
[native HTTP/TLS checks](../tests/http-inspection.integration.test.mjs).

## Decision

Use one resource-based execution contract for arbitrary commands. Separate the
requested operation, automatic task review, OS enforcement and process lifetime.
Keep the existing Pi reviewer and qualified isolation primitives; put their
resource planning behind a common interface. Do not add a privileged executor for
each framework, package manager, provider or infrastructure project.

The model proposes the smallest additional access. A separate LLM evaluates the
exact effective action against the user task. Deterministic policy and a qualified
backend constrain what can actually run. A positive review never creates a global
permission, changes the sandbox policy file or supplies a missing host capability.

## What Codex and Claude Code actually provide

| System | Relevant behavior | Implication for Pi |
| --- | --- | --- |
| Codex permission profiles | Filesystem and network rules form a reusable profile. Domain filtering requires an active proxy; enabling networking alone does not enforce it. Profiles are beta and cannot simply be mixed with legacy sandbox settings. | Compile an explicit effective resource policy and verify its enforcement, rather than accumulating configuration exceptions. |
| Codex automatic review | A separate reviewer evaluates eligible boundary crossings. It does not change the baseline sandbox. Explicit denials and reviewer timeouts have different handling. | Keep review separate from enforcement and report precise refusal causes. |
| Claude sandbox and auto mode | OS isolation and classifier review are separate layers. With auto mode, command-specific hosts can be reviewed with the command and expire when it ends; explicit network denies still apply. | Review the command and all additional resources together, with an invocation-scoped grant. |
| Background execution | Codex has sandboxed command execution with process handles. Claude background commands have task IDs and cleanup when its session exits. | Returning a job handle is useful; it is not evidence of a durable service that survives the agent. |

References: [Codex profiles](https://learn.chatgpt.com/docs/permissions),
[Codex automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review),
[Claude sandboxing](https://code.claude.com/docs/en/sandboxing),
[Claude classifier decision order](https://code.claude.com/docs/en/permission-modes#how-auto-mode-evaluates-actions),
[Codex command execution](https://learn.chatgpt.com/docs/app-server#command-execution),
[Claude background commands](https://code.claude.com/docs/en/interactive-mode#background-bash-commands).

Claude's standalone [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
already wraps arbitrary processes and is a plausible optional adapter. Its
published Unix-socket table says path allowlisting is ignored on Linux; allowing
all Unix sockets disables that seccomp blocking. A missing helper can also leave
sockets unrestricted. It therefore cannot be substituted for Pi's private-IPC
isolation without further qualification. The useful abstraction is generic, but
its defaults do not satisfy every required security property.

Local version evidence: Codex CLI 0.163.0 and Claude Code 2.1.303 were inspected.
Codex's generated experimental app-server schema includes filesystem/network
permission requests, turn/session grant scope, and a command execution profile
plus connection-scoped process IDs. These shapes establish interface availability,
not successful native enforcement or restart persistence. An attempted
`codex sandbox linux --help` returned an exec error on this installation; no
successful runtime qualification is inferred from the documentation or schema.
Codex also exposes an unsandboxed process API; that is not the execution backend
proposed here. Its [app-server documentation](https://learn.chatgpt.com/docs/app-server)
explicitly distinguishes the two APIs.

## Existing Pi pieces and gaps

| Local component | Reuse | Missing part |
| --- | --- | --- |
| [Approval review](../lib/approval-review.ts) | Separate tool-free model call; user-message authorization; policy/session binding; no stored allow; strict verdicts and refusal diagnostics. Task mode can operate without dialogs. | One canonical execution action containing every effective resource and trustworthy preflight evidence. Preserve explicit manual policy and denies. |
| [Command access](../extensions/tool-policy/command-access.ts) | Exact failed command, bounded extra writes, single-use retry, cancellation. | Proactive requests; composable network/IPC/device rights; lifetime beyond a short foreground retry. |
| [Isolated execution](../lib/isolated-command.ts) | Private source copy, private Unix IPC, clean environment, namespace isolation and bounded resources. | Shared planning with other executors; currently Linux, offline and temporary. |
| [Network access](../extensions/tool-policy/network.ts) | Exact command and destination review under filesystem confinement. | One invocation carrying filesystem and network permissions together. |
| [Git access](../extensions/tool-policy/git-access.ts) | Semantic operation validation and protected metadata transactions. | Delegate resource execution through the common engine while retaining these checks. |
| [Build sandbox](../lib/build-sandbox.ts) | Supervised namespace worker and native KVM checks. | Replace fixed build assumptions and broad host exposure with an explicit resource plan. Current build behavior is not a generic least-privilege service backend. |
| [Process runner](../lib/process.ts), [background adapter](../extensions/background-bash/core.ts) | Deadlines, output, cancellation and background completion events. | Broker-owned service identity, bounded lease and recovery independent of the short tool call. A PGID alone is insufficient for escaped descendants. |

The automatic reviewer already exists. The principal gap is composition and
lifecycle, not another LLM prompt or a larger list of command-name exceptions.

## Target interface beyond the current implementation

The resource fields below describe the complete target contract. The available
subset and actual tool arguments are listed above; devices, credential references,
listeners and leased services are not accepted by the current tool. Future adapters
can share this engine without changing legacy consent implicitly.

An execution request contains:

| Field | Meaning and boundary |
| --- | --- |
| `command` | An argv vector, or one explicit shell program string with the shell identity bound. No string interpolation by the broker. |
| `cwd` and `inputs` | Canonical directory, executable identity and immutable input snapshot or validated mounts. Symlinks require verified targets. |
| `filesystem` | Exact readable and writable roots plus immutable hard denies. Runtime dependencies are explicit; host home, credential stores and configuration are not automatically readable. |
| `network` | Exact destinations, ports and transport; separate inbound listeners and outbound connections. Private targets are explicit. No unrestricted fallback for tools ignoring proxy variables. |
| `ipc` | Private IPC inside the job, or a separately qualified host endpoint. These are different authorities. |
| `devices` | References to operator-qualified resources and their permitted operations. A writable `/dev` path is not a device authorization. |
| `credentials` | Optional references to scoped broker credentials, with allowed endpoints/operations. Never raw secrets in review payloads, logs or model output. |
| `lifetime` | Foreground, session job or leased service; finite deadline, resource limits and cleanup semantics. |
| `reason` and `evidence` | Link to the user task and broker-observed requirements. Model explanations and tool output remain untrusted evidence, never authorization. |

Start with foreground and session jobs. Add leased services only after a native
supervisor passes the qualification below. Keep device support behind its own
qualified adapter; there is no general arbitrary-device grant.

For example, the same executor could receive these minimal resource sets:

| Work | Additional resources to evaluate |
| --- | --- |
| Validate an initialized provider | Private writable temporary directory and private Unix IPC; provider binaries and configuration readable. Offline if validation needs no remote service. |
| Update a neighboring repository | Exact worktree plus transaction-managed Git metadata and the configured remote endpoint. Integration is a separate semantic action. |
| Run a local development server | Exact source/output roots, private loopback listener, session job lifetime. Exposing a host port requires a separate listener grant. |
| Start a virtualized lab | Qualified virtualization device, exact state/cache roots, required endpoints and listeners, and an owned job/service lifetime. |

These are examples of resources, not tool-name matching rules. Actual needs come
from preflight and observed behavior; a command called `validate` is not assumed
offline or harmless. A host container socket authorizes the daemon's operations
and can exceed the caller's filesystem boundary; it must not be treated as a
small private-IPC exception.

## Automatic qualification and execution

1. **Plan without side effects.** Resolve paths and runtime identity, inspect
   relevant configuration, and check backend support. A request can be made before
   execution: do not manufacture a permission failure to obtain a retry handle.
2. **Apply hard constraints.** Reject unsupported resources and explicit denials.
   Project files can describe desired resources but cannot install a backend,
   raise its ceiling, remove a deny, change reviewer settings or authorize an
   operation. The parent sandbox and host permissions always remain binding.
3. **Review the effective action.** Supply the user's authorization, exact command,
   effective baseline plus requested additions, source information and relevant
   preflight facts to the existing independent reviewer. An opaque source hash
   alone cannot explain what an invoked script does. Keep inspected content
   clearly marked as untrusted; omit credentials. Review resource combinations,
   especially confidential reads together with network destinations.
4. **Bind a single invocation.** Only an explicit allow can produce a broker-owned,
   non-forgeable handle. Bind it to the session, current authorization/policy,
   command, executable, input view, resource plan, backend version and expiry.
   Validate again immediately before launch. Never widen an approved plan during
   compilation. A reduced proposal requires a fresh concrete review.
5. **Execute and observe.** Start the selected confined backend, return structured
   state/output, and retain ownership until cleanup. The model cannot consume the
   grant from a different tool or pass it to unrelated child jobs. Descendants
   inherit exactly the parent's resource boundary.
6. **Reconcile before retry.** A capability denial can justify a new narrower plan
   or an evidenced resource addition. A program may already have made changes;
   check its effects before retrying. Explicit reviewer refusal is not a sandbox
   fault and does not permit changing the executor to obtain the same denied result.

The default automatic path has no human dialog. Uncertainty, unavailable review
or an unsupported backend returns a specific failure and permits independent
work to continue. It does not silently switch to full-host execution. Existing
operator policies that explicitly demand manual approval still take precedence;
this design does not rewrite them.

Keep approval decisions provider-agnostic through Pi's model registry. The
reviewer's independence is a separate invocation, no execution tools and a
protected policy; using a different provider is optional. Routing model requests
through Grob does not enforce filesystem, network or process permissions on the
commands being executed.

Avoid review loops: memoize unchanged denials, bound transient retries and require
new evidence or a materially safer plan. Keep explicit user restrictions across
context compaction in protected authorization state. Model-written summaries must
not convert inferred permission into a user instruction.

## Enforcement and lifetime

Use a common planner with narrow platform adapters. Prefer the existing Codex
sandbox for resource sets it can actually enforce. Reuse the private Linux worker
for private IPC and qualified resource combinations. Select one executor for an
action based on a tested capability matrix; never retry by progressively disabling
protections. A permission profile is a policy representation, not a substitute
for native tests. An SRT adapter remains optional pending equivalent qualification.

Filesystem access must survive symlink races and changes between review and
execution. Use pinned handles or immutable input snapshots as applicable. Keep
metadata, harness configuration and credential directories outside ordinary
writable roots. Generic write permission does not replace the Git transaction
checks. Prefer exact secret-directory exclusions over snapshot-expanded filename
globs for long-lived jobs; new files can appear after a process starts.

Private IPC requires an isolated filesystem/socket view, private temporary space,
closed inherited descriptors and the appropriate namespace/filter combination.
Allowing the socket syscall is only one part. The same job must still be unable
to reach host sockets, abstract host endpoints or unrelated peer jobs. Do not
assume seccomp can authorize a Unix socket by pathname.

Network policy needs an enforced route, not just environment variables. Each job
must have an isolated proxy identity or listener so simultaneous jobs do not
combine allowlists. Evaluate DNS/private-address rules and every redirect; block
direct egress that avoids the proxy. A proxy carrying arbitrary TLS does not
filter application operations or prevent exfiltration to an allowed destination.
For clients requiring non-proxy transports, report missing support or use a
separately qualified network adapter. Credential operation restrictions must be
enforced by the remote service or a qualified protocol broker; listing an allowed
operation in a request is not enforcement by a generic TCP/TLS proxy.

The supervisor owns the sandbox, its descendants and its lease. A session job
survives one tool call but ends with its session. Moving a foreground command to
the background must stay within its reviewed lifetime; extending that lifetime
requires fresh review. A leased service may outlive Pi
only when the user task calls for that lifetime and a qualified external supervisor
can enforce it. On Linux, a delegated cgroup or equivalent tested containment can
provide process-tree ownership and limits; never grant the workload the supervisor's
control socket. macOS needs its own tested equivalent. API portability does not
mean KVM or all lifetime guarantees exist on both platforms.

Status uses opaque job handles with a bound owner, not project-provided PID files.
Distinguish `starting`, `running`, `ready`, `failed`, `stopped` and `expired`.
Readiness is evidence from a declared, confined probe; a successful launch or
open port alone is not application health. Record exit status separately from
health. On cancellation, expiry or supervisor failure, reap every owned process,
revoke networking and preserve bounded diagnostic/state artifacts. After restart,
reconcile known leases without inventing new permissions. Renewal gets fresh
review; stopping an owned job uses its recorded stop authority.

Mutable outputs and arbitrary local scripts remain untrusted. An immutable entry
script does not freeze all later downloads or generated code; the resource
boundary must hold for every descendant regardless of what that code does.

## Failure contract

| Result | Next action |
| --- | --- |
| `sandbox_denied` with broker evidence | Identify the missing resource; inspect partial effects; qualify a new exact plan when authorized. |
| `policy_denied` | Honor the refusal. Continue independent work or choose a materially safer action. |
| `review_unavailable` | Bounded retry only for a diagnosed transient error; otherwise report reviewer unavailability. |
| `backend_unsupported` | Name the missing enforcement/lifetime capability; do not change host policy automatically. |
| `stale_request` | Recompute inputs and review the new action. |
| `external_failure` | Diagnose the program, service or proxy independently. HTTP 403 alone is not evidence for broader network permissions. |
| `effects_unknown` | Inspect current state before any retry; do not report successful completion. |

Diagnostics include the invocation ID, resource type, evidence source and stage.
Never manufacture a filesystem or device escalation from a generic exit code.
Audit contains effective grants, review outcome and lifecycle events with secrets
redacted; access to the audit itself remains protected.

## Delivery and qualification

1. Extract a pure resource-plan normalizer and backend support query. Keep existing
   tools functioning through adapters. No new permissions in this step.
2. Add automatic foreground execution with a single combined review. Migrate the
   current extra-write, network and private-IPC paths; retain semantic Git checks.
3. Unify session background jobs and cancellation. Introduce leased services and
   devices only after their native backends pass independently.
4. Qualify representative workloads, then install through the normal Pi package
   update path. The RKE2 lab is an end-to-end acceptance case, not a new authority.

Portable tests cover normalization, scope inclusion, hard denies, stale plans,
review availability, no allow caching, platform selection, ownership and lifecycle.
Mocked platform tests must not be counted as native qualification.

Native tests must prove the following, including negative assertions:

- Authorized writes and IPC succeed; other roots, secrets, host sockets, peer jobs
  and protected metadata remain inaccessible, including link/rename races.
- A granted destination works; unrelated hosts, ports, private-address redirects
  and direct/proxy-ignoring traffic fail. Concurrent jobs cannot borrow grants.
- Exact qualified device access works without granting the device directory,
  privilege escalation or host process signaling.
- A session job survives its tool call; exit/cancel kills detached descendants.
  A leased service survives only the promised boundary and is stopped on expiry,
  revocation and supervisor failure. Restart recovery cannot attach arbitrary PIDs.
- Denied, malformed, timed-out or stale reviews execute nothing. Partial program
  failures do not trigger an uninspected replay. No shell-host fallback occurs.
- Dirty repository files and submodules survive unrelated work. Git updates retain
  their current divergence, conflict and metadata protections.

The current automated suite checks the implemented subset and its documented
limits. Passing it does not qualify the remaining target architecture or a persistent lab. No VM should be described as RKE2 Ready
without checking the actual cluster's current readiness conditions.
