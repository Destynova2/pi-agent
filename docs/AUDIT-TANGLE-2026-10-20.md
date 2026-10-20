# Tangle audit — pi-agent

**Date:** 2026-10-20

**Scope:** current working tree, `extensions/`, `lib/`, `scripts/`, including the deployment-source snapshot and revised settings publication; source tests and external packages excluded from the graph.

**Tier:** XL: 1,303 function, method and callback definitions in 116 JS/TS/MJS files.

**Tangle score:** **85/100**, calibrated structural score; moderate confidence because dynamic calls are not resolved.

No blocking topology defect was identified. Runtime imports are acyclic. The one source-level cycle contains only type imports. No code was changed by this audit.

## Method and limits

The installed Jiti Babel parser supplied the AST, without installing packages or executing project modules. Static relative imports, re-exports and literal dynamic imports were resolved against the source inventory; every relative import in this inventory resolved. Tarjan SCC detection covered the complete file graph. Directed Brandes centrality identified the five highest-degree files for closer review.

An auxiliary lexical call graph resolved direct identifier calls, including named imports. It contains 997 distinct edges from 1,414 resolved call sites. It excludes property/method dispatch, callback invocation by Pi, computed imports, worker process edges and external packages. The 4,419 other call sites include ordinary built-ins as well as unresolved dispatch; this is not a percentage of application behavior covered. Function metrics are lower bounds and do not establish absence of complex dynamic behavior.

The graph was analyzed statically. This audit did not run application tests, provider requests or deployment commands. Shell/Python bodies and installed SDK internals are outside its AST scope. No GitHub Actions or GitLab CI configuration exists in the inspected tree, so no CI dependency graph or CI pass is claimed.

## Measured topology

| Metric | Result | Interpretation |
|---|---:|---|
| File nodes | 116 | All source files in scope |
| Distinct import edges | 233 | Includes 8 type-only edges |
| Runtime import edges | 225 | Type-only dependencies removed |
| Directed import density | 1.75% | Sparse graph |
| Source-level SCCs with multiple nodes | 1 | Two type-only dependencies |
| Runtime SCCs with multiple nodes | 0 | No runtime import cycle found |
| Weakly connected components | 12 | Largest contains 102 files |
| Longest condensed import chain | 8 nodes / 7 edges | Import depth, not runtime stack depth |
| Confirmed god functions | 0 | Highest measured score 0.557; XL threshold 0.60 |
| Functions with no resolved incoming call | 807 | Includes callbacks, methods and entry points; not dead-code findings |

The five highest-degree files were `lib/process.ts` (29 incoming imports), `extensions/tool-policy/index.ts` (19 outgoing imports), `lib/session-tasks.ts` (17 incoming), `lib/mcp-approvals.ts` (14 incoming / 2 outgoing), and `lib/approval-review.ts` (14 incoming / 1 outgoing). Process/session helpers are expected shared infrastructure; the tool-policy entry point is a registration dispatcher. Neither role establishes a god function.

| Reviewed function | Resolved in / out | LOC | Branch-count estimate | Interpretation |
|---|---:|---:|---:|---|
| `hasAutomaticReview`, `lib/approval-review.ts:78` | 8 / 1 | 3 | 2 | Shared policy query; score 0.496 |
| `reviewApproval`, `lib/approval-review.ts:94` | 6 / 4 | 119 | 62 | Complex policy flow; score 0.277, not a topology hub |
| `fingerprint`, `lib/mcp-approvals.ts:9` | 26 / 0 | 4 | 1 | Leaf utility; score 0.300 |
| `runInstall`, `scripts/install.mjs:369` | 1 / 17 | 152 | 42 | Installation entry point; score 0.405, excluded from god classification |

Branch counts include conditional expressions, logical operators, loops, catches and non-default switch cases; nested function branches belong to their own function. They are an inspection aid, not certified cyclomatic complexity or a reason to split security checks mechanically.

## Findings

**T1 — Circular type contract; Tier 1 / Minor; MEDIUM confidence.**

`lib/approval-review.ts:5` imports the `PermissionAudit` type; `lib/permission-audit.ts:6` imports `ReviewRecord` in the opposite direction. The AST SCC and the explicit `import type` declarations show a bidirectional source contract. Both edges disappear from the runtime graph: this is neither a module-initialization failure nor a release blocker.

If these contracts expand, move only the shared review-result shape to a neutral contract module and keep the implementation dependency one-way. Verify with the existing approval-review and permission-audit tests plus type checking. **Disproof/closure condition:** no SCC remains after extracting the shared shape, or the maintainers explicitly retain this small type-only cycle as the intended contract. No immediate extraction is required.

No additional anti-pattern was confirmed. In particular, library references to `scripts/codex-network.mjs` are intentional shared policy helpers, not a proven layering violation based on directory names. The Git transaction's import of extension-owned request types is also type-only.

## Cohesion and score calibration

Counts below use resolved function-call edges grouped by extension directory, `lib`, or `scripts`; external edges are counted once at each incident group. They do not measure a complete dynamic call graph.

| Group | Internal edges | External edges | Cohesion / coupling |
|---|---:|---:|---:|
| `extensions/tool-policy` | 132 | 101 | 1.31 |
| `lib` | 279 | 141 | 1.98 |
| `scripts` | 169 | 38 | 4.45 |
| `extensions/grob` | 11 | 5 | 2.20 |
| `extensions/subagent` | 48 | 1 | 48.00 |
| `extensions/web` | 0 | 11 | 0.00 |
| `extensions/dunst` | 1 | 4 | 0.25 |

Web and Dunst are adapters that intentionally call shared process, policy and RPC services; method-call omissions further undercount their internal activity. Their raw ratios do not justify merging them into their dependencies.

Applying the skill formula without that correction gives **65/100**: one source SCC costs 15, and those two adapter ratios cost 20. The reported **85/100** excludes the two unconfirmed boundary defects while retaining the source-SCC penalty. God-function, deep-chain and CI-cycle penalties are zero. The dead-function penalty is unassessed, rather than treating unresolved callbacks as dead. This score is a bounded structural indicator, not a security, correctness or runtime-performance grade.

## Spectral partition

The symmetric, unweighted file-import graph was partitioned separately within each connected component. A deterministic, mean-zero power iteration computed the Fiedler vector of the combinatorial Laplacian. The main component has second eigenvalue approximately **0.123501** and residual **5.78 × 10⁻¹⁰**. Recursive cuts have residuals below **2.3 × 10⁻⁹**.

The skill gives no numeric XL cluster-size limit. This run explicitly uses **at most 200 function definitions per cluster**, the upper bound of its medium tier; disconnected small components remain intact. The result is **23 disjoint file groups**. Useful groups include runtime installation/verification (167 definitions), delegation (76), Git transactions (85), checkpoints (58), Grob/Web transport (82), confined workers (138), and audit storage/UI (89).

The partition is exported to `.claude/tangle-partition.json`, including complete file membership, source digests and method limitations. That machine artifact stays local and is excluded from publication. It is a scheduling hint, not a proposed directory move. Shared policy/process dependencies cross cuts, so changes to those contracts still require coordination. File-level eigenvectors are **not** function eigenvectors: the artifact leaves `boundary_functions` empty and records near-zero **modules** separately. The fixed ±0.1 threshold depends on unit-length normalization and marks many modules here; it must not be read as independent proof of architectural ambiguity.

## Dead-code hypotheses and follow-up

No deletion is recommended. Zero incoming lexical calls can mean truly unused code, dynamic method/callback dispatch, exported API consumption, use by excluded tests/examples, or generated/loader registration. Pi extensions are explicitly listed in `package.json`, and methods/callbacks are outside the call resolver, so these alternatives cannot all be rejected.

Retain the type-cycle finding as optional cleanup. Use the code audit for the approval and installation flow complexity; topology alone does not support a broad restructuring. If a later change needs automated work allocation, rerun this graph after that change and inspect shared contract dependencies before using its clusters.

The separate final `npm run verify:integration` gate passed after the repairs:
649 Node tests passed, 3 explicitly skipped, and 13 Python tests passed
(`/tmp/pi-verify-qhtJ8J/result.json`, 2026-10-20 14:36:06 UTC). This regression
evidence complements the static graph; it does not make unresolved dynamic
calls part of the topology proof.
