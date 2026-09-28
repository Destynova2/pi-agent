# Local Anthropic/Pi docs compatibility workaround

Pi 0.87.1 with Anthropic OAuth and `claude-fable-5-1` returned HTTP 400
`You're out of extra usage` despite a Max 20x account. Claude Code 2.1.278
worked with the same OAuth access token. The account and organization matched.

Differential tests through an ephemeral loopback proxy isolated the failure to
Pi's generated documentation section. A condensed version succeeds without
changing the account, headers, model, tools, project instructions or identity.
The server-side reason for classifying these requests differently is unknown.
This does not establish that every such 400 is a prompt compatibility problem
or prove which billing quota successful requests consume.

## Implementation

The extension uses Pi's public `getReadmePath`, `getDocsPath`, `getExamplesPath`
helpers and the structured `systemPromptOptions.sections.docs` field.
It does not parse prompt prose, match prefixes, count lines, or hardcode an
installation path. Changes to the default prompt wording do not disable it.

Only Anthropic's default docs section is replaced. The guide retains the three
asset paths, points to the documentation index, and requires reading relevant
docs, examples and Markdown cross-references before implementation. Project
instructions, tool rules, skills and custom or forced prompts remain intact.

An incompatible structured API produces a warning once per session, including
in headless mode. Failure to import a public helper is reported by Pi's extension
loader. No credentials or request payloads are logged. No installed Pi package
is patched. This still depends on Pi's public API and cannot guarantee future
Anthropic server behavior.

Reload extensions and start a fresh session: old transcripts can still contain
the original system prompt. Remove this extension directory to revert.

## Tests

```sh
node --test ~/.pi/agent/extensions/anthropic-docs-compat/tests/compat.test.ts
```

Eight tests cover paths, arbitrary prompt wording, preserving user instructions,
idempotence, provider scope and warnings for incompatible APIs.

Optional live smoke test (uses the configured subscription/credentials):

```sh
pi --provider anthropic --model claude-fable-5-1 --print --no-session \
  --no-tools --no-extensions --extension ~/.pi/agent/extensions/anthropic-docs-compat/index.ts \
  --no-skills --no-prompt-templates --no-context-files --thinking off 'Reply only: OK'
```

## Upstream patch

Prepared locally in a source checkout of `pi` (outside this repo), branch
`fix/compact-documentation-prompt`. No commit, push or PR has been made.

The core constructs the compact guide directly. The topic-to-file lookup table
is moved to `packages/coding-agent/docs/index.md`, so it is loaded on demand
instead of sent with every request. Tests cover prompt size and preservation of
tools, instructions, skills and overrides. The local extension can be removed
once that behavior ships in the installed Pi version.

Validation: 37 targeted Pi tests pass. A live source-checkout invocation returned
OK without this extension. `npm run check` currently fails on Fireworks catalog
IDs/types in unrelated AI tests after fresh model-data hydration. No dependency,
lockfile or model-source changes are included in the patch. The full test suite
has not been run. The contribution rules require maintainer approval before a PR.
