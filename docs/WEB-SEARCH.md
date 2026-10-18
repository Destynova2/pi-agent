# Confined web search

`web_search` starts the installed Claude Code client inside the Codex sandbox.
Hooks, skills and MCP are disabled; its only tool is `WebSearch`. The executable
must be outside the writable project. The fixed worker can contact
`api.anthropic.com` and `claude.ai` through the managed proxy. This does not grant
these hosts to Bash or to the session. Explicit denials in `network-policy.json`
remain binding.

## Native login on macOS

Claude Code stores its default macOS login in the system Keychain. That login is
normally unavailable to the confined client, even when `claude auth status`
succeeds in an operator terminal.

The optional bridge reads only the default `Claude Code-credentials` entry,
extracts its unexpired access token, and passes that token in memory through the
fixed worker's stdin to the Claude child environment. It never passes the
refresh token, writes a credential file, or opens the Keychain to shell tools.
It never starts Claude outside the sandbox.

The bridge is **disabled by default**. After explicit operator consent, create
`<agent-dir>/web-search.json` with owner-only permissions (`0600`):

```json
{"keychainBridge": true}
```

This is host-owned configuration, outside the agent's writable project.
The installer preserves it and never enables it. Missing, disabled, malformed,
publicly readable, symbolic-link or hard-linked configuration cannot authorize
a Keychain read. Set the value to `false` or remove the file to disable future
reads. No reload is needed for this setting.

Existing explicit token/API-key environment settings take precedence and skip
the bridge. Custom `CLAUDE_CONFIG_DIR` logins are not bridged. An expired or
nearly expired token requires refreshing the native Claude login before a new
search; Pi never refreshes or exports the refresh token. Search consumes the
existing Claude account's quota when requested.

These mechanisms follow Claude Code's documented
[native credential storage](https://code.claude.com/docs/en/authentication) and
[`CLAUDE_CODE_OAUTH_TOKEN` environment setting](https://code.claude.com/docs/en/env-vars).

## Failure and recovery

Claude sometimes prints an authentication error to stdout before exiting 1.
Pi now retains a bounded, masked diagnostic instead of only reporting the exit
code. Errors distinguish missing login, unavailable CLI, incompatible flags,
rate limiting, sandbox denial and cancellation. Partial output is never
accepted as a successful search. There is no automatic retry or alternate
executor.

Unit tests use fictitious credentials. Native integration tests use a local
fixture CLI and verify sandbox write denial and error propagation without a
provider call. They do not prove that a real account can complete a search;
that requires a separately authorized live check.
