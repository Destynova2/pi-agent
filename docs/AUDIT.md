# Dialog and permission audit

Restart Pi after installing this package. New sessions record their observable
events in `<agent-dir>/permission-audit/requests.sqlite`. The default location is
`~/.pi/agent/permission-audit/requests.sqlite`. Existing requests stay intact;
earlier dialogs and error causes are not reconstructed.

Use `/audit` for the current project's history or `/audit session` for this
session. The command does not call a model. From the project directory:

```bash
node ~/.pi/agent/packages/pi-agent-config/scripts/audit-report.mjs
node ~/.pi/agent/packages/pi-agent-config/scripts/audit-report.mjs --json --events 100
```

From the source checkout, `npm run audit -- --project /path/to/project` runs the
same report. Options are `--target <agent-dir>`, `--project <cwd>` or `--all`,
`--session <id>`, `--since <ISO timestamp>`, `--json`, and `--events <0..500>`.
The default prints aggregate counts for the current canonical project path,
without transcripts. Counts cover the entire selected history; only the optional
timeline is bounded. Queries use a read-only SQLite transaction, including WAL.

## What is recorded

| Record | Content |
|---|---|
| `permission_requests` | Request, prompt, answer and completion timestamps; session/file, tool call, workspace, process, resource, operation, scope, source, decision and authorization status. Opaque request payloads remain fingerprints. |
| `permission_reviews` | Request ID, reviewer/model, policy fingerprint, fixed verdict and category. |
| `audit_events` | Timestamped session lifecycle, submitted inputs, user/system prompts, completed messages, tool calls/start/results, public dialogs, responses, notifications and reviewer diagnostics. Payloads are redacted and bounded. |

Event rows carry session, tool, parent-tool, permission-request and dialog IDs
when known. Concurrent permission dialogs retain their original context across
navigation. A refusal or validation error before a permission broker is reached
is visible through the tool result or notification. Textual questions and refusals
from the model remain message records; the audit does not guess their meaning.

For example, `request_podman_access` can have `permission_requests.status=granted`
and a later `tool.end` with `isError=true`. The report counts that as an approved
request with a failed tool result. A missing matching result is `unobserved`, not
success. One tool can involve several permissions, so outcome counts count
requests rather than unique operations. A successful tool result alone does not
verify a deployed application or browser rendering.

Reviewer failures distinguish `model_unavailable`, `provider_error`,
`incomplete_response`, `unexpected_tool_call`, `oversized_response`, `invalid_json`,
`invalid_verdict`, `timeout`, `cancelled`, `no_user_context` and `payload_too_large`.
Changing the scope/session/user instructions invalidates a pending review and
records a separate event. Historical reviews lack these codes and appear as
`not_recorded`.

## Coverage and privacy

The audit decorates Pi's public `select`, `confirm`, `input`, `editor`, `custom`
and `notify` methods. Standard dialogs retain their title, body, choices and
response. Custom components expose neither their rendered content nor the meaning
of their result: only their lifecycle is recorded, with `opaque-custom-ui`
coverage. Other core UI prompt events retain their available lifecycle metadata
only. Native macOS permission windows, Chrome dialogs, pixels and keystrokes are
not recorded. A `confirm(false)` can mean refusal, Escape or timeout; only an
observed abort signal establishes cancellation.

Known credential fields/formats, environment/stdin payloads, authorization
headers, cookies, URL credentials/query values/fragments, token formats and
private keys are masked before SQLite receives them. Password/token input dialogs
omit their content and response. Binary media and hidden thinking are omitted.
Individual text fields are limited to 32,768 characters; recursion, collections
and total text are bounded. Rows expose redaction counts and truncation flags.
This is not a universal secret detector: unlabelled credentials or sensitive
project prose can remain. Treat the journal as private session content, and
review a report before sharing it. Native Pi session JSONL storage has its own
policy; this audit does not rewrite those files.

The host-owned directory is `0700`, SQLite is `0600`, and linked/public storage is
rejected. Concurrent writers use WAL, full synchronous writes and a five-second
busy timeout. Permission and dialog writes complete before approval can proceed;
a missing approval journal never authorizes an action. Ordinary event capture
failures produce a visible warning and a session `audit_gap` entry; the next
successful write records the missing-event count. An interrupted process can
leave pending requests or dialogs without an answer. Neither the database nor
the report is tamper-proof against its owner.

There is no automatic deletion, transcript export, model training or permission
expansion. The journal is evidence for a later audit and reviewed improvements.
Human consent files and explicit project policies remain the only remembered
authorization sources.

## Verification

```bash
node --import ./tests/resolve-pi.mjs --test tests/audit-events.test.mjs \
  tests/permission-audit.test.mjs tests/approval-review.test.mjs
```

Tests use temporary storage and fake model/UI responses, including secrets,
parallel dialogs, navigation, storage failure/recovery, old rows, active WAL and
approved requests whose tools fail. They never make paid provider calls.
