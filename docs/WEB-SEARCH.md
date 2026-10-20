# Web search through Grob

`web_search` and `/web --search` send a bounded query to the local Grob proxy.
The request declares only Anthropic's server-side `web_search` tool. It has no
local filesystem tools, hooks, skills or MCP servers and starts no Claude process.
Provider credentials stay in Grob; Pi supplies only its dummy loopback key.

Configure a `websearch-model` route to a provider supporting WebSearch in
`~/.grob/config.toml`. `router.websearch` may point to that route. This consumes
provider quota, so use search only when explicitly requested. The main model's
choice does not select the search provider.

The query passes through the same Grob DLP pipeline as other model traffic.
`GROB_URL` must name a loopback HTTP(S) origin. Redirects, remote origins and
embedded credentials are refused. Explicit denials for the Anthropic hosts in
`network-policy.json` remain binding. This path grants no network permission
to Bash or subprocesses.

## Authentication and failures

Set up provider authentication in Grob. The former `web-search.json` Keychain
bridge and Claude environment credentials are unused by this path. Existing
files are preserved, but neither the current tool nor its legacy worker reads
or relays those credentials.

A proxy error, server-side search error, empty result, timeout or cancellation
fails the search. There is no direct-provider fallback, alternate executor or
automatic retry. Provider error bodies are not copied into tool output.

`web_fetch` remains a fixed HTTP reader without a model call and keeps its
existing destination and user-URL permission checks.

## Verification

Unit tests verify the fixed request, credential suppression and refusal behavior.
The integration test uses a loopback Grob fixture and a hostile project-local
Claude executable: the executable is never started and the outside file remains
unchanged. Live upstream behavior is checked separately with an authorized search.
