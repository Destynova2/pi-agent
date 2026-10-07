# Generic Podman access

`request_podman_access` executes one Podman engine command through the protected
host CLI. It works across projects and has no W4re or xtask dependency. For example:

```json
{
  "args": ["build", "-t", "localhost/demo:local", "-f", "Containerfile", "."],
  "timeout_seconds": 1800,
  "reason": "Build the local demo requested by the user"
}
```

Pi's ordinary Bash remains sandboxed. A `cargo xtask` process does not gain host
access from this tool: use the corresponding native Podman operations explicitly.
No project-specific deployment behavior, seed or pod replacement is implied.

## Preserve a container environment privately

For `create` or `container create`, set `env_from_container` to the source's full
64-character container ID. The bridge reads that container's environment after
approval, passes it through stdin to `--env-file /dev/stdin`, then compares the
created container's environment with the source. Values never enter tool arguments,
reviewer prompts, temporary files, progress output or permission records. Errors
from these private subprocesses are suppressed. The result contains only the new
container ID and whether verification succeeded.

```json
{
  "args": ["create", "--pull=never", "--name", "demo-candidate", "localhost/demo:new"],
  "env_from_container": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "reason": "Create the requested replacement with the existing service environment"
}
```

Obtain the real source ID using `inspect --format {{.Id}}`. The example copies
environment only. Supply the source's pod, volumes, user, entrypoint, command,
security options and other required runtime settings in `args`, then verify them
before activation. This is useful when `container clone` loses runtime settings.
The bridge injects `--unsetenv-all`, `--env-file /dev/stdin` and
`--http-proxy=false`; do not supply environment, secret or proxy override flags.
Environment entries must have ordinary variable names and single-line values;
conflicting duplicates and malformed entries are refused before creation.

The one approval covers the source inspection, exact creation and private equality
check on the pinned connection. The deadline spans all three operations. A failed
verification is an error, with the created ID when available; a candidate may
remain. The bridge never starts, swaps or removes containers automatically.
Inspect before retrying. For deployments, still follow the project's runtime
parity checks, rollback, health checks and restrictions on seeds and volumes.

## Connection and authorization

The bridge resolves Podman from the protected host PATH (or a host-set
`PI_PODMAN_BIN`). It discovers the default connection with the CLI, accepts a local
Unix socket or numeric loopback SSH address, then pins the URL and SSH identity
for that call. Changes to the default cannot redirect an approved operation.
Existing connections stored only in a custom containers.conf are not imported;
configure the default with `podman system connection` outside Pi first.

The parent interactive session is required. Every engine command passes through
the permission broker, including read-only requests. `/approvals auto <scope>`
enables the [separate reviewer](AUTO-APPROVALS.md); `auto-deny` refuses uncertainty
without a dialog. Manual remains the default for projects without a policy.

The first human approval offers refuse/allow once. After that approval, the next
human prompt for the same project and engine also offers **Toujours autoriser le
moteur Podman local pour ce projet**. Commands and arguments may differ. Choosing
allow once again keeps asking; only explicitly selecting the permanent option
saves engine access. The first-use marker survives restart but never grants access.
Automatic decisions create neither this marker nor a permanent grant.

The permanent option covers **every operation supported by this bridge** on that
local engine, including deletion, publication, host mounts and private environment
transfer. Engine resources are not isolated by project name. Subsequent requests
skip both human confirmation and automatic review. The grant is bound to the
canonical project path, connection, client executable and SSH identity; it survives
Pi restart, but does not follow another project, endpoint or changed identity.
The ordinary command restrictions, interactive-parent requirement, request audit,
timeouts and cancellation remain active. Permission to use the engine does not
itself request a deployment, deletion or any other task.

`/podman-access permissions` revokes project grants and first-use markers, cancels
pending calls and invalidates tickets in other Pi processes. It cannot undo engine
effects already performed. `/podman-access reset` cancels pending calls and clears
remembered refusals while retaining explicit project grants. A cached refusal
still blocks the exact refused operation until reset. Records are private and
stored outside the project under `<agent-dir>/mcp-approvals/`; they retain only
fingerprints, never command arguments or environment values.

## Capabilities and limits

Supported commands include build, run/create/exec, container lifecycle and
diagnostics, images, pods, networks, volumes, healthcheck and kube play/down.
Only system df/info are supported. Host helpers (compose, machine SSH), connection
management, client file transfers, global option overrides and client output-file
options are excluded. Short flags containing `c` are rejected conservatively;
use long flags, separate flag values, and `--` before a container command such as
`["exec", "--", "demo", "sh", "-c", "echo hello"]`.

Without a permanent grant, the exact executable, connection, argv, cwd and timeout
are reviewed; they are not
a proof of Containerfile, manifest, image or script contents. This is a host
capability, not filesystem confinement: the engine may access mounted host paths,
send build contexts, download dependencies or publish images. The reviewer must
apply the user's exact scope and restrictions. Neither containers nor mounts may
be used to alter Pi/Codex permissions or credentials. This tool does not grant
ordinary Bash or subagents access to the Podman socket.

No inherited provider tokens, SSH agent or proxy/connection overrides are forwarded.
Podman can still use its existing registry authentication files. The default
deadline is 300 seconds, maximum 1800; output is limited to 8 MiB, with the last
60,000 characters shown and terminal controls escaped. Stdout and stderr,
including failures, enter the conversation: do not request secret-bearing
inspection output. Prefer `request_host_access`'s sanitized `podman_inspect`.
There is no arbitrary stdin/TTY; only the private environment transfer above.
Cancellation stops the local process group; effects already
submitted to the engine may remain. Always inspect before retrying.

## Installation and validation

The normal `scripts/install.mjs --no-packages` installer copies the bridge with
the other adapters and backs up the existing installation. Restart Pi afterward;
with an unpatched Pi runtime, start `pi --no-approve` to keep project code untrusted.
`scripts/doctor.mjs --installed` checks the deployed bridge and reviewer files.

```bash
node --import ./tests/resolve-pi.mjs --test tests/podman-access.test.mjs \
  tests/approval-review.test.mjs tests/host-access.test.mjs
```

Tests use disposable executors and a fake reviewer, without paid provider calls or
real container mutations. Live connection checks validate connectivity separately
from builds and deployment health.

## Integration decision

Use the existing CLI and approval broker rather than a new daemon or a separate
backend for every application. The official [Podman remote interface](https://docs.podman.io/en/latest/markdown/podman-remote.1.html)
supports explicit URL/identity options, allowing the approved endpoint to remain
fixed. No Podman upgrade is required to add this adapter. Local verification used
client 6.1.2 with server 5.8.2; that version difference alone does not establish a
deployment failure or justify replacing the user's VM.
