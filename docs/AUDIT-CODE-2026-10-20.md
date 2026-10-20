# Code quality audit — pi-agent-config

Date: 2026-10-20. Scope: the working tree based on `1a4688a`, including the native SDK migration, Grob transport and terminal commands, checkpoint selection, confinement, and release-based reload.

**CQI after corrections: 7.9/10 — good overall.** Remaining findings: Tier 3 (0), Tier 2 (3), Tier 1 (0). The initial score was 7.7/10 with two Tier 3 findings; both are now resolved by reviewed changes and targeted host regressions. The full completion gate also passed for the corrected tree; see the final completion evidence below.

The score and counts above describe the audit snapshot published in `2bcba71`.
The subsequent maintenance follow-up below resolves CODE-03 and CODE-05, leaving
CODE-04 open. No new overall score is claimed.

## Method and limits

The review sampled 20 production files, initially 3,435 lines, plus their callers and relevant tests. Large files were inventoried by function declarations and inspected in focused sections. No production file over 300 lines was loaded whole as the first step.

The production sample was:

- `scripts/install.mjs`, `scripts/deploy.sh`, `scripts/codex-shell.mjs`, `scripts/update-runtime.mjs`, `scripts/doctor.mjs`, `scripts/check.mjs`, `scripts/test.mjs`.
- `lib/runtime-paths.mjs`, `lib/harness-activation.mjs`, `lib/grob.ts`, `lib/jj-checkpoint.ts`, `lib/execution-plan.ts`, `lib/process.ts`.
- `extensions/grob/command.ts`, `extensions/grob/index.ts`, `extensions/tool-policy/harness-update.ts`, `extensions/tool-policy/jj-checkpoint.ts`, `extensions/tool-policy/execution.ts`, `extensions/confined-lsp/worker-session.mjs`, `extensions/graphify/core.ts`.

Evidence combines source review, an isolated installer race reproduction, a mocked doctor/transport comparison, and inspection of the installed Pi SDK's settings persistence. The existing integration evidence recorded 649 Node tests: 646 passed, 3 skipped, 0 failed; all 13 Python tests passed. Its source digest was `ed3c97ccfdfa82516c8c23b821480938ece593ce1dd4187978fef29437396003`. That suite was not rerun by this audit and does not prove changes made after it.

The follow-up reviewed `scripts/deployment-snapshot.mjs`, the revised settings transaction, and the added regressions. The host run recorded in `/tmp/pi-audit-regressions.gElQ2p.log` passed 34 tests with no failures or skips, including a real SDK settings update during copying, settings-lock contention, and installation after the original checkout changes.

This is a sample-based audit, not exhaustive coverage, a penetration test, or a measured performance assessment. Function spans below are physical lines from the initial review, not computed cognitive complexity. An attempted TypeScript compiler-API inventory was unavailable in the installed native compiler package; no parser metric is claimed. Dependency graph measurements belong to the separate tangle report.

## Scores

Weighted points are `weight × score / 10`; their sum is the CQI.

| Category | Weight | Score | Weighted points | Evidence |
|---|---:|---:|---:|---|
| C1 Naming and readability | 8% | 0.85 | 0.680 | Intent-based capability names; dense validation expressions remain |
| C2 Functions and complexity | 12% | 0.60 | 0.720 | CODE-04: long installation, sandbox and publication functions |
| C3 Module design | 10% | 0.72 | 0.720 | Cohesive small transport/path modules; installer combines many phases |
| C4 DRY and change amplification | 8% | 0.80 | 0.640 | CODE-03: doctor duplicates a weaker Grob URL policy |
| C5 Errors and robustness | 10% | 0.80 | 0.800 | Fail-closed workers and explicit failures; CODE-03 diagnostic mismatch remains |
| C6 Type safety and idioms | 8% | 0.75 | 0.600 | Typed boundary requests; CODE-05 semantic type checking absent |
| C7 Comments and API documentation | 5% | 0.85 | 0.425 | Useful rationale for credential isolation, immutable objects and signal handling |
| C8 Test quality | 12% | 0.90 | 1.080 | Real SDK reload and PTY coverage, now including concurrent settings |
| C9 Security and validation | 10% | 0.90 | 0.900 | Credential stripping, canonical roots, narrow capabilities and negative tests |
| C10 State and immutability | 7% | 0.85 | 0.595 | Release retention, shared settings lock and private deployment source |
| C11 Control flow | 5% | 0.68 | 0.340 | Guards are explicit; nested lifecycle/transaction closures increase review cost |
| C12 Dependencies and architecture | 5% | 0.80 | 0.400 | Shared process supervision and capability separation; SDK adapter coupling |
| **CQI** | **100%** | | **7.900 / 10** | |

The skill's mechanical remaining debt estimate is approximately 1.5 hours (three flags at half an hour each), SQALE-inspired grade A against the sampled line count. This is a triage heuristic, not an implementation estimate; extraction and SDK type-check qualification can take longer.

## Resolved Tier 3 findings

### CODE-01 — concurrent Pi settings can be overwritten during activation

- **Status:** resolved. `scripts/install.mjs:306` now acquires `settings.json.lock`, rereads and validates current settings, applies `selectPackage` (`scripts/install.mjs:407`), and activates under that lock. Copying and external `pi install` calls run outside the settings lock.
- **Category / pattern:** C10, C5 — Lost Update; shared state without a common synchronization protocol.
- **Confidence:** high. Source inspection plus an executed isolated reproduction; the installed SDK's persistence code confirms a different locking protocol.
- **Initial locations:** `scripts/install.mjs:366`, `scripts/install.mjs:415`, `scripts/install.mjs:425`, `scripts/install.mjs:450`; merge behavior at `scripts/install.mjs:261`.
- **Trigger:** a running Pi session saves a theme or model after the installer's initial settings check and before its activation rename.
- **Observed behavior:** the installer prepares settings from `theme: "before"`. The reproduction writes `theme: "during-install"` immediately before the activation rename. Installation succeeds, but the final theme is `"before"`.
- **Cause:** `.harness-install.lock` serializes installers only. The SDK uses `proper-lockfile` on `settings.json`, reads current contents under that lock, and merges only its modified fields. The installer writes an earlier complete snapshot without joining that protocol.
- **Impact:** the new ability to keep sessions open exposes lost preference updates during ordinary deployment. Atomic rename protects file integrity, but does not preserve another writer's changes.
- **Fix:** publish the release first; acquire the SDK-compatible settings lock briefly; reread settings and merge only the intended installer changes; activate under that lock. Do not hold this lock while calling `pi install`, which itself writes settings.
- **Validation:** run a real SDK settings save concurrently with installation and assert preservation of the session's preference and the installer's release selection. Also test an already-held settings lock and failure cleanup.
- **Disproof:** a shared lock or equivalent transactional protocol covers the settings read/merge/write, and the concurrent-writer regression preserves both changes.
- **Repair evidence:** `tests/harness-releases.test.mjs:131` uses the installed SDK's `SettingsManager` to save during copying and after activation; both settings and release selection survive. The lock-contention regression at line 154 preserves the prior settings and another writer's lock. Both passed in the 34-test host run.

### CODE-02 — deployment can install a different source after the successful gate

- **Status:** resolved for changes to the original checkout. `scripts/deploy.sh:59` creates a private source snapshot before any gate, then changes directory to it for checking, staging, integration verification and live installation. `scripts/deployment-snapshot.mjs:8` copies tracked and non-ignored untracked files plus private Git metadata.
- **Category / pattern:** C5, C10 — Time-of-check/time-of-use; temporal coupling.
- **Confidence:** medium in this code audit: direct cross-file control-flow evidence, without an independent deployment mutation reproduction here.
- **Initial locations:** `scripts/deploy.sh:59`, `scripts/deploy.sh:62`, `scripts/deploy.sh:66`, `scripts/deploy.sh:68`; copy from the live source at `scripts/install.mjs:430`.
- **Trigger:** the source changes after `verify:integration` completes, particularly while the deployment waits for `DEPLOY`.
- **Observed control flow:** the gate verifies the working source and staged installation; after confirmation the script invokes `scripts/install.mjs` again from that working source. It neither checks the previous source identity nor selects the already-tested payload.
- **Impact:** the live release can contain code that the successful gate never tested. The later doctor compares against the newly changed source and is not a substitute for executing the tests on that source.
- **Fix:** bind activation to the verified source identity and reject changes, or install an immutable staged payload with all required runtime files. Keep the identity check adjacent to the activation boundary.
- **Validation:** mutate a source file while confirmation is pending; assert that the live settings and runtime stay unchanged and deployment fails clearly.
- **Disproof:** the live installation consumes the exact verified payload, or a source-identity check rejects the changed tree before any live installation effect.
- **Repair evidence:** `tests/deploy.test.mjs:114` changes the original source after snapshot creation and verifies that installation still receives the captured contents. It also checks dirty Git state, ignored-file exclusion and refusal of existing or nested destinations. This regression passed in the 34-test host run. The snapshot remains owner-writable; this does not defend against deliberate modification of the private staging directory by another process with the same user privileges.

## Tier 2 — major flags

### CODE-03 — doctor and the Grob transport disagree about a valid endpoint

- **Follow-up status:** resolved. Both callers use `lib/grob-url.mjs`; health requests reject redirects and invalid URLs without echoing credentials. See the maintenance evidence below.
- **Category / pattern:** C4, C5 — Duplicated Validation; divergent policy.
- **Confidence:** high. Cross-file inspection and an executed network-free comparison with a mocked `fetch`.
- **Locations:** `scripts/doctor.mjs:87`; `lib/grob.ts:6` and `lib/grob.ts:15`.
- **What:** doctor uses raw `fetch` and follows its default redirects. Model transport only accepts a loopback HTTP(S) origin without credentials/path and rejects redirects.
- **Reproduction:** with `GROB_URL=https://example.invalid` and a mocked HTTP 200, doctor reports the Grob proxy healthy; `grobUrl` refuses the same URL. No actual request to that hostname was sent.
- **Impact:** diagnostics can report success for a configuration that cannot handle model traffic. This audit did not establish credential disclosure from this check.
- **Fix:** share the same URL and redirect validation, retaining the doctor's explicit distinction between proxy health and OAuth authentication.
- **Disproof:** malformed, non-loopback and redirected configurations receive consistent rejection from both diagnostic and model transports.

### CODE-04 — transaction functions carry too many review obligations at once

- **Category / pattern:** C2, C3, C11 — Long Method.
- **Confidence:** medium. Function boundaries and manual responsibility tracing agree, but line count alone is not proof of a defect.
- **Locations / initial spans:** `scripts/install.mjs:349` (`runInstall`, 149 lines); `scripts/codex-shell.mjs:177` (`launch`, 133 lines); `lib/jj-checkpoint.ts:327` (`publishCheckpoint`, 93 lines).
- **What:** installation mixes validation, preference migration, backup, copying, publication, activation and external package installation. Sandbox launch mixes several parsers, policy binding, environment preparation and OS launch. Checkpoint publication mixes result validation, object validation, lock acquisition and ordered metadata writes.
- **Impact:** changing one phase requires retaining the invariants of several others; the settings race is a concrete example of a phase interaction that tests originally missed.
- **Fix:** extract coherent, testable phases such as activation merging and launch-profile parsing. Keep ordered publication and lock lifetime visible in one orchestrator. Avoid one-use wrappers that merely rename individual statements.
- **Disproof:** the phases already have independent contracts and can be reviewed or changed without carrying unrelated state, or a proposed extraction hides more invariants than it exposes.

### CODE-05 — the completion gate does not perform semantic TypeScript checking

- **Follow-up status:** resolved. Both verification gates now require `scripts/typecheck.mjs`, using the selected installed SDK and managed compiler. See the maintenance evidence below.
- **Category / pattern:** C6, C8 — Missing Feedback Loop at an SDK adapter boundary.
- **Confidence:** medium. The configured scripts and their callers were inspected; no concrete currently failing type assertion is claimed.
- **Locations:** `scripts/check.mjs:24`, `scripts/check.mjs:62`, `scripts/test.mjs:109`; `package.json` scripts.
- **What:** `check` validates `.mjs` syntax and whitespace; tests execute TypeScript through the installed runtime. Neither runs a semantic type check over the extension APIs and request/result interfaces.
- **Impact:** the strong runtime suite catches exercised behavior, but interface mistakes in an unexercised SDK adapter path can survive this gate.
- **Fix:** consider a separate SDK-backed type-check target covering the adapter boundaries, resolving against the existing Pi installation. Do not install duplicate SDK packages or weaken the behavioral checks.
- **Disproof:** a required completion gate already performs semantic checks for these TypeScript boundaries against the selected installed SDK.

## Good practices

- `lib/grob.ts:15` pins every model request to the selected proxy origin, strips upstream authorization/cookies and refuses redirects. Provider overrides also cover restored provider/model identities (`extensions/grob/index.ts:88`).
- `extensions/grob/command.ts:66` keeps OAuth interaction in a human-controlled terminal, uses a fixed executable/argument array, checks idle parent TUI state and never copies credential output into model context. Cancellation and Ctrl+C have real PTY coverage.
- `tests/harness-releases.test.mjs:21` exercises a real SDK session: nested ESM modules change after reload, old tool references retain the old release, history/session identity remain intact and the shell path follows the new release.
- `scripts/install.mjs:174` verifies the digest of an existing release before reuse, and failed settings activation retains the previous selection. Negative tests cover tampering, symlinks, ambiguous selection and concurrent installers.
- `lib/jj-checkpoint.ts:327` checks captured blobs, limits allowed metadata changes and preserves the real Git index/branches. Repository override tests include aliases, subdirectories, replacements during approval and scoped revocation.
- `lib/process.ts:37` bounds output and execution time, supervises descendants and separates a reaping delay from persistent permission failures. These are tested behaviors, not broad error suppression.
- `lib/execution-plan.ts:87` revalidates resource identity and policy before launch; the extension scopes job ownership to the current session and closes jobs on lifecycle changes.

## Next steps

Consider focused extraction of the transaction phases described in CODE-04 when
changing those paths. The diagnostic and semantic-check findings are resolved.

Resolved findings retain their original evidence and initial line references for traceability. Current scores and remaining-finding counts include the reviewed repairs.

## Final completion gate

After the repairs, `npm run verify:integration` passed on the Linux host with the
installed Pi 1.3.0 SDK selected through `PI_PACKAGE_JSON`: 148 `.mjs` files checked,
649 Node tests passed, 3 explicitly skipped, and 13 Python tests passed. The skips
cover the two macOS-native checks and the optional browser profile. Report:
`/tmp/pi-verify-qhtJ8J/result.json`, completed 2026-10-20 14:36:06 UTC. This is
runtime regression evidence, not semantic TypeScript checking or proof of live
provider authentication.

## Maintenance follow-up

The upstream Pi lifecycle/API documentation, TypeScript compiler documentation
and Python standard-library guidance were checked against this project; sources
and supported scope are recorded in [development conventions](../INSTALLATION.md#development-conventions).

The initial strict TypeScript run found 35 diagnostics. Shared typed lifecycle
registration, a single subagent parameter schema, public SDK tool adaptation and
correct proxy model options resolve them. The gate checks production TypeScript;
JavaScript and test fixtures still rely on runtime coverage. Python syntax
checking uses temporary bytecode outside the checkout, and unittest cleanup is
registered during setup.

The final `npm run verify:integration` passed with Pi 1.3.0 and TypeScript 7.0.2:
151 `.mjs` files checked, semantic TypeScript checking passed, 5 Python files
compiled, 652 Node tests passed, 3 explicitly skipped and 13 Python tests passed.
Report: `/tmp/pi-verify-9ShtYD/result.json`. Negative regressions prove that an
unknown Pi event, invalid Python syntax or either failed static-check phase
prevents a successful verification result. The skipped checks remain the two
macOS-native checks and the optional browser profile.
