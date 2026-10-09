# Automatic approval review

Legacy permission requests use manual confirmation by default.
`request_network_access` with `command` reviews the current task automatically.
An uncertain or unavailable review opens a one-time human validation in an
interactive session; a saved manual policy requests that validation directly.
The complete command, project, hosts and scope are shown before approval.
`auto-deny`, explicit denials and missing UI still prevent execution. No grant
is saved and no refused command is automatically retried.

`run_isolated` and `git_access` push with `private_network: true` use per-task
review without dialogs. An explicitly saved manual policy disables these
no-dialog operations. See [private IPC](PRIVATE-IPC.md) and
[private Git push scope](ORCHESTRATION.md#git-operation-consent). An interactive parent can
delegate their evaluation to a separate, tool-free model call for one project:

```text
/approvals auto Build and update the local demo service demo-1; preserve its volumes; no push or remote deployment.
/approvals status
/approvals manual
```

Use `/approvals auto-deny <scope>` to avoid approval dialogs: uncertainty, an
unavailable reviewer or an invalid answer denies the operation. `auto` falls back
to the existing human dialog for those cases. An explicit reviewer denial stops
the request in either mode. Other extension dialogs are outside this setting.

The command itself is the user's opt-in. It stores the scope under
`<agent-dir>/approval-policies/`, outside the writable project. The policy is
private, canonical-path-specific and survives restart. Subprojects do not inherit
it. The current provider/model is pinned when the command runs; changing the main
model does not silently change the reviewer. Run the command again to change its
model, scope or uncertainty handling. Requests use the pinned model's configured
authentication, quota and billing, with a 30-second deadline.

## What gets reviewed

The broker reviews new command/filesystem/Metal and network requests, and fresh
host/MCP/Git/checkpoint approvals. It sees the exact proposed operation, the
standing project scope and every user message on the current branch. Tool results,
assistant claims and compaction summaries are excluded. Oversized context falls
back instead of silently dropping an older restriction. No tools are exposed to
the reviewer. Only a complete, strictly validated JSON `allow` can grant access.

For example, a request to restart `demo-1` can be evaluated against the standing
scope above. A request to push the repository still needs user authorization for
that publication. The working agent's own justification is not that authorization.
The model can make mistakes: these tests validate enforcement and lifecycle, not
the accuracy of a live model's judgment.

Existing executor limits still apply: exact paths, supported operations, protected
runtime files, parent-only capabilities, network deny rules, executable identity,
expiry and cancellation. Auto review does not install missing Podman/Metal/W4re
backends, introduce a host shell, or enable unsupported tools. These one-command capabilities work without UI. With a configured automatic
policy, the parent can also use command/write/Metal, host, Podman, build, Git,
worktree and checkpoint review without UI. These host capabilities receive fresh
automatic review in that mode, even if a human previously saved broader consent.
Manual requests without UI remain denied. Terminal sizing is checked only for
human dialogs. Dunst retains its interactive-only boundary; none of these host
capabilities is delegated to subagents. Ordinary actions already allowed by the sandbox do not
make an extra model call.

## Memory and revocation

Automatic success never creates a remembered MCP/host/Git grant or expands the
policy. Every fresh approval is reviewed again. Explicit human session/project
grants retain their existing behavior and revocation commands. Cached human
refusals retain precedence over auto review.
Explicit model refusals and uncertainty refusals are also cached for the same
session, user context, policy and action (bounded to 512 entries). A changed task,
policy or action is reviewed afresh. Provider unavailability is not a standing
refusal. A network request refused only because no UI was available can be
reviewed again when the parent becomes interactive. Explicit denials remain
binding. The cache never grants access or becomes reviewer training/context.

GPU-only Metal requests and tools in the configured isolated Playwright container
offer once/session/project consent. Metal consent covers eligible commands with
the same qualified backend, without extra file or network rights. Browser consent
covers one named tool with all its arguments, including site interactions and
JavaScript. Saving or reusing human grants requires the interactive parent. Metal
without UI instead requires a configured automatic policy and fresh exact review;
browser consent remains interactive-only. A saved human grant skips the dialog
and the model review; a past one-time answer is never promoted automatically.
If auto review keeps approving once, use `/approvals manual` to expose the human
choice on the next request, then re-enable auto with the desired scope if needed.

The [Podman bridge](PODMAN-ACCESS.md) offers engine-wide project access at the next
human prompt after a human once approval. Only an explicit human choice saves
that grant. In an interactive session it then skips both prompts and automatic
review for supported commands on the same local engine and project. Without UI,
a configured automatic policy and fresh exact review are still required. Automatic successes never create
the first-use marker or select this option. Other capabilities keep their current
approval choices and do not acquire this broader permission.

`/approvals manual` invalidates pending automatic review tickets and disables new
reviews. A changed scope, session or user message also invalidates a pending
review. It cannot undo effects already performed. Existing remembered human
grants are separate; revoke them with `/mcp permissions`, `/git-access permissions`
or `/jj-checkpoint permissions`; use `/command-access permissions` for Metal and
`/podman-access permissions` for the Podman
engine grant and its first-use marker. Legacy human-approved network grants last
until the Pi session ends. New automatic network requests must include `command`
and never save session grants. The exact host set lasts only for that supervised
command and its descendants; it includes uploads and all ports. Restart Pi to
discard old session grants.

## Audit and verification

The existing `permission_requests` table records automatic approvals with
`source = 'policy'`. The additive `permission_reviews` table distinguishes model
review from static policy: request ID, timestamp, verdict, fixed reason category,
model and policy fingerprint. The separate `audit_events` timeline records the
redacted reviewer request, structured verdict, precise failure code and masked
error message. It also links public approval dialogs to the permission and tool
call. An unavailable permission journal prevents execution. None of these tables
is consulted as permission or training data. Use `/audit` or the
[read-only report](AUDIT.md) to inspect failures; historical unavailable reviews
without diagnostics remain unknown.

```bash
node --import ./tests/resolve-pi.mjs --test --test-timeout=15000 \
  tests/approval-review.test.mjs tests/mcp-approvals.test.mjs \
  tests/permission-audit.test.mjs tests/command-access.test.mjs \
  tests/network-policy.test.mjs tests/host-access.test.mjs
```

Tests use a fake model and disposable executors. They make no provider calls and
do not operate real containers. Install with the normal backup-producing installer
and restart Pi before using the new command. Installation preserves explicit project policies. Legacy capabilities remain
manual until project opt-in; the no-dialog capabilities above qualify the current
user task unless a saved policy overrides that default.
