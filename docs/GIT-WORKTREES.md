# Worktree cleanup with approval

`git_worktree_cleanup` lets the interactive parent inspect and retire linked Git
worktrees. It does not need a failed Bash command first. Ask Pi to inspect the
worktrees and propose the paths to retire; Pi presents the concrete operation
through the approval dialog. Long details are paginated, with approval choices
available only after the last page. Escape refuses the request.

The operations are:

| Operation | Scope | Approval |
| --- | --- | --- |
| `inspect` | Registered linked worktrees, optionally selected absolute paths | Read-only, no dialog |
| `remove` | 1–20 explicit existing worktree paths | One exact operation |
| `prune` | 1–20 explicit missing worktree paths | One exact operation |

Removal archives the entire directory, including staged, modified, untracked
and ignored files, and its Git metadata. It keeps every local branch and creates
a recovery ref for each HEAD, including detached commits. A branch with unpushed
commits therefore does not require a push-or-discard decision merely to retire
its worktree. Push and branch deletion are separate decisions; this tool does
neither. Local remote-tracking refs are reported as local evidence, not as a
fresh verification of remote state.

The existing `/approvals` policy applies to the exact request. Cleanup never
creates a session or project grant and never inherits `git_access` permission.
`/git-worktree reset` cancels pending cleanup and clears refusals. Existing
archives remain. Child agents and headless execution cannot use this capability.

## Storage and recovery

The result gives a private archive path under
`<agentDir>/worktree-archives/<id>/` and its `receipt.json`. For each worktree,
the receipt records the original path, branch, HEAD, metadata, archive directory
and `refs/pi/worktrees/<id>/<index>` recovery ref. That ref prevents ordinary
Git garbage collection from discarding the retained commit. The receipt also
records completed moves, including during a partial failure.

Each numbered archive contains `worktree/` for an existing directory and
`metadata/` for its registration and index. The original Git pointer files are
preserved, so the archive is recovery storage, not a ready-to-use worktree.
Restore requires a separately reviewed plan that checks path collisions and
updates the reciprocal Git pointers. There is no automatic restore or purge.
Keep the main repository: its objects are still needed for commit recovery.
Archiving on the same filesystem reclaims the old path, not disk space.

## Boundaries and next actions

Git inspection runs offline in the OS sandbox, with fsmonitor, custom filters,
submodule recursion and maintenance disabled. After approval, the parent rechecks the complete inventory, takes
Git metadata locks and renames only the approved directories. It never runs
host Git or opens filesystem access to Bash. Branch tips, files and metadata
changed during review invalidate the request.

- Active/current worktree: finish its work and request cleanup from a different
  active workspace.
- Locked worktree or merge/rebase/index operation: identify its owner and wait
  or prepare a separately approved unlock/operation resolution.
- Nested repository: preserve and review it separately before retiring its parent.
- Different filesystem: prepare an explicit copy, verification and removal plan.
- Partial failure: inspect the receipt and actual paths before requesting another
  operation. Do not blindly repeat the original cleanup.

Ordinary main repositories with a `.git` directory and normal files-based refs
are supported. Runtime/configuration directories cannot be cleanup targets.
Inspection is bounded to 1000 registrations, 250000 entries per selected tree
and bounded metadata/protocol sizes; narrow the request when necessary.

## Large commits

`git_access` accepts up to 1000 explicit file paths within a bounded request.
Staging still excludes directories and implicit wildcards; committing still
requires the exact complete staged list. The agent must inspect ownership and
propose logical commit groups when needed. Permission to write Git metadata
does not itself request a commit or push. Hooks remain enabled and confined;
each push still requires its own exact destination and commit approval.

For a 160-file change, Pi can present the full selected list across approval
pages and execute the requested commit. It need not ask the user to run a
terminal command solely because the list exceeded the former 100-file limit.
