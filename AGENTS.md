# Working agreement

## Finish the authorized task

- Treat implementation, regression checks and the final result as one task. Do not ask whether to continue after a diagnostic or an expected test failure.
- Read the relevant code and callers, identify the cause, make the smallest correction, then verify it. Continue through fixable failures within the original scope.
- A background process is pending work, not completion. Use its completion notification, inspect its result and continue; do not send a final answer merely announcing that tests are running.
- Preserve existing user changes. Do not commit, publish, install globally or alter unrelated files without authorization.
- Ask only for a decision or permission that genuinely blocks progress. Continue independent authorized work while an approval is pending.

## Verification

- Run `npm run check` and the relevant tests after changes. Run `npm run verify` for the standard completion gate; use `npm run test:integration` when the required host services are available.
- Tests use the installed Pi SDK, not project npm dependencies. If `pi` is a wrapper, export `PI_PACKAGE_JSON` pointing to that installation's `@earendil-works/pi-coding-agent/package.json` (see `INSTALLATION.md`). Do not install duplicate SDK packages to fix resolution.
- Write command logs under `$TMPDIR`, not hard-coded `/tmp`. Preserve each command's exit status; successful log printing does not mean the command succeeded.
- Separate assertion failures from missing prerequisites and sandbox restrictions. Never mark an unexecuted test as passing, remove assertions or relax protections to obtain a green result.
- This project's standard suite also exercises sandbox launches and local HTTP. A restricted outer sandbox can prevent those checks: inspect the actual error, finish runnable checks and report the exact remaining host command. Do not bypass the outer sandbox or automatically retry a denied operation.

## Completion

- Finish with changed paths, checks actually executed and any specific unresolved blocker. Do not substitute a plan, a progress update or an offer to finish for completed work.
- If blocked, report the missing capability and the smallest next action once. Repeated background notifications are not reasons to repeat the same warning or ask again for permission already granted.
- Instructions improve execution discipline; they do not grant new tool permissions or guarantee that a model follows them.

Workflow references: [Codex coding prompt](https://github.com/openai/codex/blob/main/codex-rs/core/gpt-5.2-codex_prompt.md), [Codex persistence instructions](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/persistent_mode.md).
