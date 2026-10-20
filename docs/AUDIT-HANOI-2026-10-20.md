# Installation and deployment ordering audit

Date: 2026-10-20. Scope: the working tree based on `1a4688a`, including the
versioned harness release implementation. Scores describe the inspected code,
not the availability of external providers.

## Verdict

The release layout fixes the largest operational inversion: changing harness
code no longer requires stopping every Pi session. Native `/reload` selects a
new module path while old sessions retain their existing files. Keep this
ordering.

Two existing trade-offs remain: harness installs always invoke all six external
package installers, and settings become active before those installers finish.
The audit also found a gap between deployment verification and the live copy.
The corrected workflow now runs every phase from a private source snapshot;
the regression passed in the 34-test focused installation suite.

Scores are review judgments out of 10, not benchmark results.

| Artifact | Stability | Legality | Economy | Displacement | Main observation |
|---|---:|---:|---:|---:|---|
| `scripts/install.mjs` | 7 | 7 | 6 | 9 | Source-only changes still run six package installs; partial dependency failure keeps the new selection |
| `scripts/deploy.sh` | 8 | 9 | 7 | 9 | Corrected and tested: all gates and live installation use one private snapshot |
| `scripts/verify.mjs`, `check.mjs`, `test.mjs` | 9 | 9 | 9 | 9 | Cheap check first, evidence reuse only for unchanged inputs, full tests always run |
| `scripts/update-runtime.mjs` | 9 | 9 | 8 | 9 | Candidate SDK is installed and tested before launcher activation; old SDK stays available |
| `containers/playwright/Containerfile` | 10 | 9 | 9 | 9 | Pinned dependency/browser installation precedes the volatile entrypoint copy |
| `scripts/build-codex-sandbox.sh` | 9 | 9 | 8 | 9 | Hash verification and patching precede the isolated build; cold rebuild cost is unmeasured |

## Findings

### HN-01 — Live copy qualification gap corrected in source

**Original tier 3 — Critical; confidence: high; law: legality; status: resolved.**

At the inspected baseline, `scripts/deploy.sh:59`–`68` runs the gate from the
checkout, waits for `DEPLOY`, then invokes the installer from that same mutable
checkout. `scripts/verify.mjs:69` rejects changes during verification, but its
scope ends before the prompt. An edit after the gate can therefore become part
of the live installation without being tested. This is a qualification gap,
not evidence that an untested version was deployed in this session.

- **Blast radius:** one late source edit can invalidate the qualification of
  the entire live copy. The observed package contains 146 regular files.
- **Correction:** take a private source snapshot before the gate and execute
  the check, staging, tests, and live installation from that snapshot. Preserve
  Git metadata needed by the existing whitespace gate.
- **Invariant:** the package copied live must derive from the exact source
  snapshot that passed verification; preserve failure statuses and the live
  installation backup.
- **Disproof condition:** demonstrate that a checkout edit after a successful
  gate either cannot affect the live payload or prevents live activation.
- **Correction inspected:** `scripts/deployment-snapshot.mjs:8` copies the Git
  file inventory and private Git metadata, excluding ignored untracked files.
  `scripts/deploy.sh:59` creates it, and `:60` enters it before every subsequent
  gate and live installation.
- **Regression inspected:** `tests/deploy.test.mjs:114` creates the snapshot,
  changes the original checkout to invalid source, then verifies that the real
  installer still installs the snapshot's original content. It also checks
  preservation of Git diffs and exclusion of an ignored private fixture.
- **Regression executed:** the focused host run of `tests/deploy.test.mjs`,
  `tests/install.test.mjs`, and `tests/harness-releases.test.mjs` passed all
  34 tests with no failures or skips. The late-edit snapshot test appears as
  passed in `/tmp/pi-audit-regressions.gElQ2p.log`.
- **Status:** resolved in the audited source. The original severity remains
  recorded for traceability. No full-suite result for these final corrections
  is claimed by this report.

### HN-02 — Six dependency installer calls accompany every harness install

**Tier 2 — Major; confidence: high; laws: stability and economy.**

`settings.json:9` declares six pinned external sources.
`scripts/install.mjs:332` iterates every source, and `:487` invokes the loop
unless `--no-packages` is explicitly selected. Both staging and live deployment
use the default at `scripts/deploy.sh:62` and `:70`.

This couples frequently edited extension code to more stable dependency work:
one source-only deployment invokes `pi install` **12 times**, six in staging
and six live. This counts process invocations, not network requests or actual
downloads; Pi/npm may satisfy work from their own caches.

Evidence is triangulated:

- Static control flow contains two full installer invocations and six specs.
- The successful stage and live installation logs each list those six specs.
- A disposable fixture using the real `runInstall` and a fake Pi executable
  recorded 12 calls for two installs separated only by an extension edit.

Keep the fresh staging dependency check. A candidate improvement is to skip
the six **live** installer calls only when the required specs and installed
artifact identity have already been verified. Its target is **12 → 6 calls**
for a source-only deployment, or **6 → 0** for a standalone source-only install
with equivalent validated dependency evidence. Time savings are unmeasured.

**Disproof condition:** a command trace showing the current default installer
already avoids those calls for an unchanged, verified dependency set. Dependency
caching inside Pi does not disprove the process count, but may reduce the
benefit enough to reject this optimization.

### HN-03 — Dependency failure leaves the new harness selected

**Tier 2 — Major; confidence: high; law: legality.**

`scripts/install.mjs:472` activates the merged settings before dependency
installation at `:488`. A failed dependency install is accumulated and the CLI
returns failure at `:584`; it does not restore the previous selection.
`tests/install.test.mjs:361` explicitly preserves resource copying on a package
failure, so this is an existing partial-install contract rather than an
unreported regression.

A disposable fixture confirmed the ordering: after a successful v1 install,
changing the extension to v2 and failing one of the six fake package installs
produced one reported package failure, while settings still selected the v2
release and that release contained v2.

- **Blast radius:** one failed package can leave one newly selected release
  with unresolved dependencies. Depending on what changed, this may require
  repair or retry before reload is usable. No live failure was reproduced.
- **Candidate:** separate dependency preparation from selection, or document
  and preserve the current partial-success recovery contract. Moving the
  existing `pi install` loop upward alone is insufficient because Pi can
  rewrite settings and shared dependency trees.
- **Disproof condition:** failure injection demonstrates that the previous
  selection and required dependency artifacts remain usable after every
  supported dependency update failure.
- **Status:** `needs_invariant`; **NEEDS-REVIEW**. A transactional dependency
  redesign is outside this audit and is not recommended as an automatic patch.

## Inventory and measured costs

The inventory included `package.json`, `settings.json`, installation/deployment
and verification scripts, the SDK updater, the sandbox backend build script,
the Playwright Containerfile and entrypoint, activation helpers, relevant
fixtures, and installation documentation.

No GitHub workflow, GitLab CI definition, Ansible playbook, Kubernetes manifest,
Compose file, Makefile, root Cargo workspace, or project dependency lockfile was
found in the current checkout. No external CI configuration was inspected.
Runtime sandbox, container networking, and approval policies were read only
where they explain installation prerequisites; this is not their security
audit. Long-document prose ordering was not scored.

History was measured with
`git log --since=6.months --no-merges --format= --name-only`. Available history
runs from 2026-09-27 through 2026-10-18; these are **commit-touch counts**, not
an estimate of edits per day. Current uncommitted edits add no history count.

| Input | Commits touching it |
|---|---:|
| `extensions/tool-policy/index.ts` | 28 |
| `extensions/orchestrate/index.ts` | 18 |
| `scripts/install.mjs` | 16 |
| `settings.json` | 9 |
| `package.json` | 8 |
| `extensions/tool-policy/harness-update.ts` | 7 |
| `scripts/deploy.sh` / `scripts/test.mjs` | 5 each |
| `scripts/check.mjs` / `scripts/update-runtime.mjs` | 3 each |
| `scripts/verify.mjs` | 2 |
| Playwright Containerfile / sandbox backend build script | 1 each |

The top three executable inputs all trigger the same deployment sequence:
one check, two harness copies, two doctors, one complete integration gate,
12 package installer calls, and no mandatory Pi process restart for a
harness-only change. HN-02 changes only the redundant live dependency calls;
it does not remove either doctor or the integration gate.

Observed deployment evidence:

| Measurement | Result | Evidence |
|---|---:|---|
| Initial syntax/whitespace check | 4,333.789 ms; 147 `.mjs` files | `/tmp/pi-deploy.BGhRsSCM/check.json` |
| Reused check subprocess | 85.495 ms | `/tmp/pi-verify-eaIiYH/result.json` |
| Full test subprocess, including Python | 80,040.657 ms | Same verification report |
| Selected test files | 121 | Same verification report |
| Node results | 649 total; 646 passed; 3 skipped; 0 failed | `/tmp/pi-verify-eaIiYH/test.log` |
| Python results | 13 passed | Same test log |
| Published harness payload | 146 regular files; 928,420 bytes | Filesystem inventory of release `e51b2e04…bb48` |
| External installer calls per deployment | 12 | Source, stage/live logs, and disposable fixture |

These timings describe one earlier successful run, not an audit benchmark.
The skips concern macOS-specific or optional browser coverage; embedded
negative-test messages about missing SDKs are not failures of the overall run.
No installation duration, network byte count, container build time, or Rust
build time was measured. The published file count is the deployment baseline;
later audit fixes may change it.

## Execution stacks and proposed changes

### Harness installation and deployment

Current installation:

```text
validate paths/schema → acquire lock → backup → copy complete release
  → publish content-addressed release → select settings
  → install six external packages → restore package filters → report activation
```

The release publication correctly precedes selection, and old release files
remain available. The native SDK regression in
`tests/harness-releases.test.mjs:21` exercises nested `.mjs` reload, session
history preservation, and old references retaining old behavior.

Deployment at the inspected baseline:

```text
mutable checkout → check → stage install → stage doctor → full integration
  → operator confirmation → reread checkout for live install → live doctor
```

HN-01 implemented correction:

```text
private source snapshot → check → stage install → stage doctor → full integration
  → operator confirmation → install that snapshot live → live doctor
```

HN-02 proposal adds a validated dependency decision inside installation:

```text
prepare release → validate required dependency identity
  → install missing/changed dependencies only
  → retain the documented activation and failure contract
```

This is a patch sketch, not an instruction to bypass dependency checks.

### Verification

`check.mjs:54` reuses successful syntax evidence only when the input fingerprint
matches. It still checks Git whitespace and compares inputs again at the end.
`verify.mjs:25` runs the cheap check before tests and never caches a test pass.
The initial 147 syntax subprocesses are not repeated during the staged gate
when nothing changed. Keep this implementation.

### SDK update, browser image, and backend build

The SDK updater checks version compatibility, installs a separate candidate,
hashes and verifies it, checks the hash again, then atomically replaces the
launcher (`scripts/update-runtime.mjs:283`–`296`). Its no-op current-version
branch avoids installation and verification work. Full integration is justified
when the SDK changes; it is a compatibility boundary, not wasted work.

The Playwright image pins its base and installs MCP/Chromium before copying
`entrypoint.mjs` (`containers/playwright/Containerfile:1`–`7`). Editing the
entrypoint does not invalidate the preceding dependency installation in a
normal cached build. No reorder is justified.

The backend build verifies its source archive before extraction and patching,
then uses `cargo build --locked`. Each invocation creates a fresh Cargo target
directory (`scripts/build-codex-sandbox.sh:16`, `:25`). Shared build caching could
reduce repeated work, but this script changed once and no repeated build cost
was measured. Leave it unchanged until recurrence justifies that complexity.

## Displaced responsibilities

| Capability | Natural owner | Observed implementation | Judgment |
|---|---|---|---|
| Reload harness code while preserving sessions | Harness release and Pi loader integration | Content-addressed package roots, native `/reload`, restart detection for shared external dependencies | One coherent source-level solution; no duplicated stop/restart compensation remains in deployment |
| Validate a new Pi SDK before selecting it | Runtime updater | Isolated candidate and launcher activation | Appropriate integration boundary |
| Preserve localhost origins inside the browser container | Container networking adapter | `containers/playwright/entrypoint.mjs` forwards explicit selected ports | Legitimate platform responsibility, not application retry logic |
| Qualify source before production selection | Deployment workflow | HN-01 corrected with a private snapshot shared by all phases | Artifact binding belongs in this layer; no need to duplicate ad hoc checks in every caller |

No confirmed missing capability compensated independently in two or more of
Docker, Kubernetes, and Ansible was found. Their absence is not evidence that
external deployments have no such duplication.

## Optimization card HN-02

- **Location:** `scripts/install.mjs:332`, `:487`; `scripts/deploy.sh:62`, `:70`.
- **Observed structure:** every default install iterates all six package specs.
- **Candidate:** reuse live dependency installation only after validating the
  exact specs and installed artifact identity.
- **Required invariants:** missing or modified packages are repaired; pinned
  versions and resource filters are preserved; lifecycle scripts stay disabled;
  personal packages are retained; external code changes still require restart;
  staging remains independent of an unverified live dependency tree.
- **Validation:** trace fake Pi invocations for unchanged, changed, missing and
  tampered dependencies; inject package failures; run the existing installation
  and native reload regressions; measure real install duration and network
  activity before claiming a speed-up.
- **Expected impact:** six fewer live installer calls for a source-only deploy;
  latency benefit unmeasured; no proposed reduction in security checks.
- **Risk:** medium. A stale cache decision can skip a required repair.
- **Status:** `benchmarkable`, subject to a dependency-integrity invariant.
- **Confidence:** high for the observed call count; medium for the optimization.
- **Next owner:** installer maintainer, followed by a focused performance check.

## Limits and follow-up

The audit did not install packages, run the full suite again, rebuild images,
rebuild the sandbox binary, or change implementation code. It read the existing
successful integration evidence and executed one disposable real-installer
fixture with a fake package CLI, without network access. It then inspected the
coordinator's focused 34-test host result for the audit corrections.

HN-01's focused regression proof is complete. Keep HN-03 explicit as a partial-install
contract unless a separate transactional dependency design is authorized.
Evaluate HN-02 against measured installation cost before introducing a cache.
Retention of old releases is deliberate; automatic deletion would require
proof that no live session still references them.

After the repairs, the separate completion gate `npm run verify:integration`
passed on Linux with the installed Pi SDK: 148 `.mjs` files checked, 649 Node
tests passed, 3 explicitly skipped, and 13 Python tests passed. Final evidence:
`/tmp/pi-verify-qhtJ8J/result.json` (2026-10-20 14:36:06 UTC). This does not change
the measured dependency-call count or qualify the proposed dependency cache.
