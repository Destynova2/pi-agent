# Playwright browser capability

An MCP server can list its tools successfully while Chrome still fails to start.
On macOS, Codex's sandbox can deny Chrome's Crashpad files and Mach services.
Tool discovery does not qualify navigation, DOM reading or browser interaction.

This optional profile runs Playwright MCP 0.0.83 and headless Chromium in a
disposable local Podman container. The parent broker implements fixed image
inspection, container creation, attachment and cleanup. It never executes a
configured host command or retries a failed native launch automatically.

## Prepare and select the image

From the source checkout, with a working default local Podman connection:

```bash
podman build -t localhost/pi-agent/playwright-mcp:0.0.83 \
  -f containers/playwright/Containerfile containers/playwright
podman image inspect --format '{{.Id}}' localhost/pi-agent/playwright-mcp:0.0.83
```

The Containerfile pins the official base by digest, installs the exact MCP version
with npm lifecycle scripts disabled, and explicitly downloads its matching
Chromium. It does not modify the host's Chrome or Pi SDK. Build from the reviewed
source; the image label is a version diagnostic, not a publisher attestation.

Register the server normally:

```bash
pi mcp add playwright -- npx -y @playwright/mcp@0.0.83 --isolated
```

In the protected user configuration `~/.pi/agent/mcp.json`, add `browser` to that
server's entry. Replace the placeholder with the full local image ID from above
(including `sha256:`). A tag is intentionally rejected:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.83", "--isolated"],
      "network": true,
      "browser": {
        "image": "sha256:<64 hexadecimal characters>",
        "localhostPorts": [8092]
      }
    }
  }
}
```

Preserve other server entries. The profile accepts this command only, optionally
with a final `--headless`, and no custom environment or browser flags. Omit
`localhostPorts` when it is unnecessary. At most 16 distinct ports between 1024
and 65535 can be relayed. Set `network: false` without relays for offline pages.
Definitions are re-read on each MCP call; changes close the affected connection.
Restart Pi after installing changed extension code.

## Permission and isolation

The first connection requests a browser launch grant: once for that browser
lifetime, for the session, or permanently for this project. The grant binds the
definition, executable identity, local engine, protected SSH key, exact image and
network/relay configuration. Changing them requires new consent. The existing
`/approvals` reviewer may approve a launch within its user-defined scope; it never
creates a permanent grant. Child agents cannot launch or use this profile.

`/mcp permissions playwright` revokes both launch and tool grants for this project
and closes connections. `/mcp` closes connections without deleting project grants.
Each named tool offers once, session or project consent. A remembered tool grant
covers all its arguments, including clicks, navigation and JavaScript that can
modify sites or send data. It binds the project, server configuration, exact image
and tool declaration. Changing any of them requires new consent. Sensitive browser
tools require the interactive parent even with a saved grant. A matching grant
skips both the dialog and automatic model review. Past one-time approvals are not
converted into project grants.

This choice is specific to the configured isolated browser profile. Other MCP
servers offer remembered consent only for unverified read-only annotations;
their sensitive tools still require approval of each exact operation.

The container runs as UID 1000 with a read-only root filesystem, dropped Linux
capabilities, no privilege escalation, 2 GiB RAM, two CPUs, 512 processes, 256 MiB
shared memory and a 512 MiB temporary filesystem. It receives no host directory,
Chrome profile, credential environment or engine socket. Chromium uses
`--no-sandbox` inside this outer container boundary, matching Playwright's
container launch requirements; ordinary host tools keep their Codex sandbox.

With `network: true`, the browser has full container egress, including reachable
local services. This is separate from Codex's public-host network allowlist and
is displayed in launch consent. A remembered grant does not authorize sending a
message, placing an order or submitting a form without the user's request.

`host.containers.internal` reaches the host. For an application whose cookies or
origin checks require `http://127.0.0.1:8092`, the example relay listens only inside
the container and forwards that port to the host. It publishes no host listener.
The application must be reachable from the Podman VM/container; the relay does
not make a host service bound only to an inaccessible interface reachable.

Cancellation, configuration replacement, revocation and session shutdown remove
only the randomly named container created by this connection. Cleanup requires a
working engine. A hard host crash can leave a labeled container; inspect
`podman ps -a --filter label=io.pi-agent.browser-mcp=1` before removing a known
orphan. Never remove other sessions' browser containers indiscriminately.

## Use and verify

Call `mcp` with `server: "playwright", tool: "help"` for tools, or
`args: { "name": "browser_click" }` for the current input schema. In 0.0.83,
`browser_click` expects `target`, not `ref`.

Navigation returns a snapshot file link. Call `browser_snapshot` **without a
filename** to receive DOM text and element references inline. These files are
inside the container, not readable by the host file tool. Screenshots arrive as
image content. Uploads/downloads and explicit file outputs stay inside the
disposable container; this profile does not provide a host file-transfer bridge.

After the standard installation staging, qualify the selected image explicitly:

```bash
PI_TEST_BROWSER_IMAGE=sha256:<full-local-image-id> \
  node --import ./tests/resolve-pi.mjs --test tests/browser-mcp.integration.test.mjs
```

Set `PI_PACKAGE_JSON` to the installed Pi SDK when using a wrapper. The native
test creates its own page and temporary agent configuration, checks denied
launches, real localhost navigation, DOM references, a harmless click, PNG
capture, host isolation, revocation, configuration replacement and canceled-call
cleanup. No model credentials or live application mutations are needed. The
full integration gate includes this test when `PI_TEST_BROWSER_IMAGE` is set;
otherwise the optional browser profile is explicitly reported as unqualified.
