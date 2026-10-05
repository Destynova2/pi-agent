# Code Quality Audit — pi-agent web consent

**Target:** exact user-URL reads, their sandbox launcher and installation path; related LSP compatibility regression. **Language:** TypeScript / JavaScript. **Date:** 2026-10-05.

**CQI:** 8.4/10 after remediation. This is a scoped review, not a whole-repository or backend security certification. **Findings:** Tier 3 — Critical: 3 resolved; Tier 1 — Minor: 1 resolved. **Open debt from these findings:** 0h. The skill's initial repair heuristic is 6.5h; it is not measured engineering time.

## Scores by category

| # | Category | Weight | Score | Weighted | Evidence |
|---|---|---:|---:|---:|---|
| C1 | Naming and readability | 8% | 0.85 | 0.0680 | Dedicated consent, fixed reader and explicit diagnostic names |
| C2 | Functions and complexity | 12% | 0.80 | 0.0960 | Small consent module; launcher retains several capability branches |
| C3 | Module design | 10% | 0.85 | 0.0850 | Human input, policy, process supervision and OS sandbox have separate roles |
| C4 | DRY and change amplification | 8% | 0.85 | 0.0680 | Existing proxy and process supervisor reused; source/runtime drift reconciled |
| C5 | Errors and robustness | 10% | 0.80 | 0.0800 | HTTP refusals, redirects, cancellation and compiler failures exercised |
| C6 | Type safety and idioms | 8% | 0.85 | 0.0680 | Standard URL/Set/AbortController; JS process boundaries validated explicitly |
| C7 | Comments and API docs | 5% | 0.85 | 0.0425 | Exact-read scope and ordinary-GPU denial documented |
| C8 | Test quality | 12% | 0.85 | 0.1020 | Reproduced missing cases; real HTTP, sandbox and install checks |
| C9 | Security and validation | 10% | 0.90 | 0.0900 | Fixed GET, no redirect or credentials, explicit deny wins, no Bash grant |
| C10 | State management | 7% | 0.85 | 0.0595 | Workspace/session-scoped bounded consent; duplicates no longer evict |
| C11 | Control flow | 5% | 0.80 | 0.0400 | Early rejection at boundaries; explicit lifetime management |
| C12 | Dependencies and architecture | 5% | 0.80 | 0.0400 | No added dependency; existing Pi compiler only where native transform is absent |
| | **CQI** | **100%** | | **8.39/10** | |

## Critical violations resolved

### C9 — URL extraction granted a different destination

- **Tier:** 3. **Confidence:** HIGH, static inspection plus executable reproduction.
- **File:** `lib/web-consent.ts:14` (original extraction was at line 13).
- **Evidence:** `https://example.com/report?title=l'article` authorized the prefix ending in `title=l`; the full URL was denied. A bare URL ending in `)` was similarly truncated. Truncating input at the size limit could cut a URL as well.
- **Principle:** Preserve the exact authorization subject at a trust boundary. This was a path/query mismatch, not a general network or filesystem escape.
- **Fix:** Retain URL punctuation; remove a closing delimiter only when an explicit opening delimiter precedes the URL. Reject oversized input rather than authorizing a truncated prefix.
- **Disproof condition:** The finding would be invalid if the prefix were never authorized. Both the old implementation and runtime reproduction authorized it.
- **Verification:** The regression in `tests/web-consent.test.mjs` covers bare and wrapped apostrophes, brackets, parentheses and the input limit. Alternate paths/queries remain denied.

### C4/C12 — Reinstalling this checkout removed the installed Metal adapter

- **Tier:** 3. **Confidence:** HIGH, source/runtime comparison plus a disposable real installer run.
- **Files:** `scripts/install.mjs:12`, `scripts/install.mjs:302`, `scripts/codex-shell.mjs:79`.
- **Evidence:** Before reconciliation, the installed launcher accepted `--metal`, while the checkout did not; a temporary installation changed `beforeMetalFlag=true` to `afterMetalFlag=false`. The managed files also omitted `scripts/metal-backend.mjs`.
- **Principle:** Deployment must reproduce the validated runtime. The prior isolated merge had not been incorporated into this dirty checkout.
- **Fix:** Reconcile the 28 files from the previously reviewed Metal/LSP changes through three-way merging, preserving local additions. Include the Metal backend module in the managed installer files. No Git index or history was rewritten.
- **Disproof condition:** A reinstall retaining the complete adapter before the fix would invalidate the finding; the isolated reproduction showed the opposite.
- **Verification:** A fresh install matched the qualified runtime's launcher, backend and broker; a second install retained Metal and created a backup. The installer regression now checks that the backend module is copied. Ten native broker/Metal checks passed.

### C5/C6 — The LSP compiler path failed under Node 24

- **Tier:** 3. **Confidence:** HIGH, loader inspection plus the actual installed LSP package failing on Node 24 and loading on Node 26.
- **File:** `extensions/confined-lsp/pi-lsp-module-hook.mjs:70`.
- **Evidence:** The Jiti CommonJS load path failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` for the ESM-only Pi SDK under Node 24.15.0. The repository advertises Node >=22.19.
- **Fix:** Use Node's native TypeScript-to-ESM transform when supported. Retain the existing Jiti path on Node 26, where native transform mode was removed. Both remain limited to the pinned LSP package; project Babel configuration and compiler caches remain disabled.
- **Disproof condition:** Successful loading through the original CommonJS path on the failing runtime would invalidate this observation; the original test failed reproducibly.
- **Verification:** Actual package registration and six native LSP worker scenarios pass on Node 24.15.0; registration and the native worker scenarios also pass on Node 26.10.0. This is not a claim that every supported Node release was tested.

## Minor flag resolved

### C10 — Repeating a URL evicted an unrelated authorization

- **Tier:** 1. **Confidence:** HIGH, Set update inspection plus a 64-entry reproduction.
- **File:** `lib/web-consent.ts:23`.
- **Evidence:** Remembering URL 63 again after inserting URLs 0–63 removed URL 0 even though no new destination was added.
- **Fix:** Evict only when adding a new URL to a full set.
- **Disproof condition:** If the repeated URL did not evict another entry the finding would be invalid; the reproduction demonstrated that it did.
- **Verification:** The regression checks both duplicate retention and eviction when adding the 65th unique URL.

## Anti-pattern and Ponytail review

No Fowler/Mantyla structural smell was established in the reviewed change. The four findings above are concrete correctness and delivery defects; they are not reasons to invent a broader refactor.

Applied the upstream [Ponytail skill](https://github.com/dietrichgebert/ponytail/blob/main/skills/ponytail/SKILL.md) and its [review instructions](https://github.com/dietrichgebert/ponytail/blob/main/commands/ponytail-review.toml). The consent object owns bounded session state. The small worker and process wrapper enforce a real capability boundary. Existing URL parsing, proxy enforcement, cancellation and compiler facilities are reused. No new dependency, generic authorization framework or full Markdown parser was added.

**Additional removable lines: 0.** Removing the fixed worker or weakening URL validation would remove required behavior. This simplicity result does not substitute for the correctness checks above.

## Validation and delivery

- 49 targeted tests passed under Node 24.15.0, including consent, policy, installer, broker and compiler regressions.
- Three LSP module tests also passed under Node 26.10.0.
- Eleven HTTP/proxy/web/LSP integration tests passed on the native Mac under Node 26.10.0; six LSP worker scenarios also passed under Node 24.15.0.
- Ten native Metal broker checks passed: exact approval, computation, protected writes, result journal, one-shot use, ordinary GPU denial, nested-upgrade denial, session cancellation, descendant cleanup and cancellation journal.
- `scripts/check.mjs`: 78 JavaScript modules checked; `git diff --check` clean.
- Source reconciliation backups and proof artifacts: `/private/tmp/pi-audit-reconcile-20261005/`.
- Three runtime files installed with precondition hashes, backups and post-copy verification: consent, LSP module hook and its adjacent runtime comment. Backup: `/Users/ludwig/.pi/audit-web-deployment-2026-10-05T06-43-16Z/`.
- A fresh Pi RPC process loaded the installed LSP, MCP, host/Git access, confinement and web commands; `/web https://example.com/` returned the page without an approval dialog or model request. The Metal approval guidance was present. Evidence: `fresh-pi.json` in the proof directory above.

Existing interactive Pi processes need `/reload` to load the changed extensions. At audit completion, the source reconciliation and web/LSP edits were local working-tree changes; publication is a separate step. Existing native sandbox restrictions were retained; no unrestricted host command was introduced.
