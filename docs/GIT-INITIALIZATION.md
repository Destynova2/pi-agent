# Initialize an empty main and a populated develop

The parent-only `git_repository_init` tool creates a new SHA-1 repository in an
existing canonical directory. Its exact one-time approval covers an empty root
commit, a local author identity and one credential-free HTTPS remote. It refuses
any existing `.git` or `.jj`, including dangling links. Existing files stay
untracked. The source repository and global Git configuration stay unchanged.

## Workflow

1. Inspect the source repository and its remote branches. Fetch and compare when
   needed: initializing a destination does not establish that the source is up to
   date. Review the files and checks for the intended import.
2. Create a separate directory within the workspace or its private `$TMPDIR` with
   ordinary confined file tools. Select a durable workspace directory if it must
   survive temporary-file cleanup.
3. Call `git_repository_init` with the new directory, `branch: "main"`, the target
   remote, the user's explicit identity and `message: "chore: initialize repository"`.
4. Copy the reviewed source content into that directory. An archive of `HEAD`
   includes committed tracked files only; separately review any uncommitted work
   that belongs in the import. Do not copy `.git`, `.jj`, session storage or secrets.
5. Call `git_access` with `repository` set to the new directory and
   `operation: "branch", branch: "develop"`. Stage explicit reviewed paths, then
   commit with the complete staged path list and a Conventional Commit message,
   for example `feat: add developer portal`.
6. Inspect `main`, `develop` and the final content. For an authorized publication,
   request two separate pushes: `source_branch: "main", branch: "main"` and
   `source_branch: "develop", branch: "develop"`, with the configured remote.

`source_branch` is important when `develop` is checked out: without it, a push
uses the current HEAD. The approval binds the resolved immutable source commit
and destination. Neither initialization nor the tests contact the remote or
prove that credentials, branch rules or CI will work there. The normal public
HTTPS host allowlist and confined authentication requirements still apply.

## Boundaries and cancellation

The fixed initialization worker runs Git, templates, hooks and signing offline
inside Codex, using private scratch metadata and a scratch worktree. It receives
no write access to the destination or source. The parent checks bounded regular
metadata, object hashes, the empty tree, root commit, branch and fingerprint,
then exclusively creates the destination `.git`. It never replaces existing
metadata. A publication I/O failure may leave partial metadata: inspect it before
retrying; there is no automatic rollback or replay.

Only ordinary repository configuration is published: the requested identity
and remote plus Git's basic format flags. Template redirects, executable config,
includes, object alternates and linked metadata are rejected. Hooks can edit the
commit message as in ordinary Git; attempts to change the empty tree are rejected.
Signing or hooks requiring unavailable services fail without bypassing checks.

`/git-init reset` cancels pending initialization and clears refusals. Session
navigation and shutdown cancel the worker too. The tool is absent from subagent
capabilities. Subsequent `git_access` calls select the repository inside the
original session's sandbox; this does not expand Bash's writable workspace.
Hooks needing writes to another worktree can consequently fail.
Use `/git-access permissions /canonical/repository/path` to revoke remembered
Git consent for that repository from the original session.

## Native validation

Use the installed Pi SDK (`PI_PACKAGE_JSON` when `pi` is a wrapper), from a host
where Codex can create its sandbox:

```sh
node --import ./tests/resolve-pi.mjs --test \
  tests/git-init.test.mjs tests/git-init.integration.test.mjs \
  tests/git-access.test.mjs tests/git-access.integration.test.mjs
```

These disposable fixtures cover the empty main/develop history, local identity,
template hooks and signing failures, metadata tampering, refusal/cancellation,
immutable push-source selection and real filesystem confinement. No production
repository, credentials or real push are used.
