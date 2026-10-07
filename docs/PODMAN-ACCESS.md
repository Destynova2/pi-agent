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
`/podman-access reset` cancels pending calls and clears remembered refusals.
Automatic decisions never expand the scope or become persistent grants.

## Capabilities and limits

Supported commands include build, run/create/exec, container lifecycle and
diagnostics, images, pods, networks, volumes, healthcheck and kube play/down.
Only system df/info are supported. Host helpers (compose, machine SSH), connection
management, client file transfers, global option overrides and client output-file
options are excluded. Short flags containing `c` are rejected conservatively;
use long flags, separate flag values, and `--` before a container command such as
`["exec", "--", "demo", "sh", "-c", "echo hello"]`.

The exact executable, connection, argv, cwd and timeout are reviewed; they are not
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
There is no stdin/TTY. Cancellation stops the local process group; effects already
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
