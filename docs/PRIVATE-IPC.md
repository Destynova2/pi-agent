# Private IPC and one-command network access

`run_isolated` executes a Linux command against a disposable copy of explicit
project inputs. Unix sockets work between its processes without exposing host
sockets. The command cannot change the original project or a live service.
`request_network_access` with `command` handles dependency downloads separately:
only that command receives the requested public destinations.

Both operations use a separate, tool-free LLM review of the current user request.
They work without UI, never show a confirmation dialog, and never save a grant.
An existing project approval policy takes precedence, including an explicit
`manual` policy, which disables these no-dialog operations. An uncertain,
unavailable, malformed or stale review refuses execution. Historical success,
tool output and the working agent's justification do not authorize access.

## OpenTofu example

Prepare providers without contacting the infrastructure backend. Keep their data
directory outside files watched by a live deployment controller. For example,
from the project root, the command submitted for network review can be:

```sh
TF_DATA_DIR="$PWD/.cache/tofu-validation" CHECKPOINT_DISABLE=1 \
  tofu -chdir=opentofu/config init -backend=false -input=false -lockfile=readonly
```

Name every required registry/download host in `hosts`. Redirect destinations also
need to be allowed. Inspect the lockfile and actual download URLs; do not guess a
wildcard. The managed proxy continues to reject private addresses and explicit
network-policy denials. This is host access, including uploads and all ports, not
a GET-only permission. It retains the ordinary Codex filesystem/read policy.
Initialization failures must be inspected before another bounded attempt.

Once dependencies exist, a `run_isolated` request can use:

```json
{
  "command": "TF_DATA_DIR=/work/.cache/tofu-validation tofu -chdir=opentofu/config validate -no-color",
  "inputs": ["opentofu/config", ".cache/tofu-validation"],
  "binaries": ["/absolute/path/to/installed/tofu"],
  "reason": "Validate the requested configuration without contacting Nexus or changing live state"
}
```

`binaries` copies installed standalone ELF executables into `/job-bin`. Use the
actual installed path; no binary is downloaded or installed by this tool. Dynamic
executables must find their dependencies in the mounted OS runtime. Additional
private libraries are not implicitly imported. Cached provider symlinks must be
materialized as regular files in the prepared input directory. No SDK/provider
package is installed to repair resolution automatically.

The working directory is `/work`; input paths retain their project-relative
layout. Output is returned, but generated files are discarded. This is suitable
for validation and offline tests, not live `plan` or `apply`. A project's combined
check script may need separate prepare/offline phases to use this capability.

## Enforcement

- Strict Linux user, mount, PID, IPC and network namespaces; capabilities dropped,
  further user namespaces disabled, no host-network option or unconfined fallback.
- An architecture-checked seccomp filter allows only Unix socket creation, denying
  IP, netlink, packet and VM socket families as well as `io_uring`, `ptrace` and
  cross-process memory syscalls. Kernel keyrings, BPF, performance counters and
  file-handle opens are denied too. x86-64 compatibility/x32 ABI bypasses are denied.
  This profile does not provide TCP loopback; tests requiring HTTP need a separate
  qualified capability. A network namespace alone is not the VM-socket boundary.
- Only administrator-owned, non-writable OS runtime trees under `/usr/bin`,
  `/usr/lib` and `/usr/lib64` are shared read-only. Links cannot expose an unmounted
  host path. Writable/non-root-owned entries and special files fail qualification.
  Administrator-only subdirectories that cannot be inspected are covered by
  empty read-only mounts; their contents are never exposed to the job.
  The host administrator and installed kernel/runtime remain trusted.
- Inputs are copied using pinned directory descriptors and no-follow opens.
  Symlinks, hardlinks, sockets/devices, path traversal and unsafe storage are
  refused. Copies are bounded to 20,000 entries, depth 64 and 512 MiB total.
- Common credential/state names (`.env*`, `.ssh`, `.aws`, `.kube`, `*.tfstate*`,
  `*.pem`, `*.key`) and agent/VCS metadata are excluded. This is not a secret
  scanner: choose only necessary inputs, which can themselves contain sensitive
  application data.
- The exact snapshot and imported binaries are hashed before review. Later
  edits of the original files do not change what this job executes. The snapshot
  is mounted read-only at `/input` and copied into a private 1 GiB `/work` tmpfs.
  No host filesystem is writable by the job.
- `/tmp` is private, short and bounded to 256 MiB; `/home` is a private 16 MiB
  tmpfs. `TMPDIR` and `PLUGIN_UNIX_SOCKET_DIR` point to `/tmp`. Host `/run`, home,
  temporary files, cloud environment variables and agent sockets are absent.
- Execution lasts at most 120 seconds with a combined 1 MiB output limit.
  Cancellation and session navigation stop the supervised process tree. Its PID
  namespace reaps descendants; snapshots are removed after completion or failure.
  An abrupt host/process crash can leave an inert private snapshot requiring
  cleanup after confirming no job still uses it.

The plain Bash adapter retains its existing Codex policy. Its project-specific
temporary path now uses a 128-bit directory identifier instead of 256 bits, which
shortens the observed provider path from 126 to 94 bytes. This does not authorize
Unix syscalls or guarantee a short path under an arbitrarily long home directory;
`run_isolated` provides the short path and private IPC together.

## Failure and qualification

`listen unix …: socket: operation not permitted` identifies a refused socket
creation. A later bind error can instead involve the pathname length (normally
107 bytes maximum on Linux). A generic `Unrecognized remote plugin message` alone
does not prove either cause. Incident hints suggest bounded diagnosis; they never
create permissions.

This backend requires Linux x86-64 or AArch64 with usable unprivileged namespaces, protected
`/usr/bin/bwrap` supporting `--disable-userns`, and a verifiable OS runtime. An
outer sandbox cannot be relaxed by the child. Non-Linux systems and outer
namespaces that hide runtime ownership fail explicitly.

Run on the actual host, using the installed Pi SDK as described in
[INSTALLATION.md](../INSTALLATION.md):

```sh
npm run check
node --import ./tests/resolve-pi.mjs --test \
  tests/isolated-command.test.mjs tests/approval-review.test.mjs \
  tests/private-ipc-seccomp.test.mjs \
  tests/command-access.test.mjs tests/network-policy.test.mjs \
  tests/codex-shell.test.mjs tests/incidents.test.mjs
node --import ./tests/resolve-pi.mjs --test \
  tests/isolated-command.integration.test.mjs
npm run verify
```

The native regression checks private pathname/abstract IPC, absence of host
paths and inherited environment, external network failure and discarded writes.
Also run the real locked OpenTofu providers through `run_isolated` before claiming
application acceptance. Unit tests with a fake reviewer establish lifecycle and
enforcement, not live-model accuracy or successful provider validation.

For projects with automatic reconciliation, publishing into watched files is a
deployment. Stage candidates outside those paths. The reviewer is instructed to
consider that effect, but ordinary file tools keep their existing workspace
permissions: this feature does not discover or interpose on arbitrary watchers.
