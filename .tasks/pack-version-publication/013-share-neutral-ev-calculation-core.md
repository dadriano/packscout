# Task: Share the Existing Neutral EV Calculation Core

**ID:** pack-version-publication/013
**Depends on:** pack-version-publication/001, pack-version-publication/005
**Blocks:** pack-version-publication/011
**Delivery phase:** P05B
**Estimated scope:** medium, behavior-preserving extraction
**Status:** done

## Merged — 2026-09-05

With the user's conditional merge approval, PR121 squash-merged at15:00:24UTC as `0ea6145470a276807a0e9590d759d9fad85e9226`. Root verified its tree is identical to certified14c64485/runtime77c01707, current CI33945214745 passed, bot thumbs-up and no open findings. New main includes the neutral core;011 still waits for003/004. No writer, route or production data activation occurred.

Latest verification: full framework CI33945214745 PASSED at published head14c64485 on mainf6785251, completed2026-09-05 05:06:21UTC. Runtime77c01707 is unchanged from the locally certified core. PR121 remains open/non-draft with no known finding; no new implementation is required before prerequisite merge approval.

## Objective and measured boundary

Move the existing pure buyback EV calculator, confidence evaluator and public value primitives behind the browser-neutral domain boundary so native V1 readiness can replay the exact same calculation. Preserve current formulas, policy identifiers, errors and existing consumers. This is shared domain logic, not a release-response adapter or a second contract.

Partial011 measured10 source files/2,337 changed lines before capture/readiness/query wiring. A coherent8-file/2,225-line extraction is independently merge-safe on main; the two incomplete `pack-catalog-economics` files remain with011. This measured split changes no product outcome or existing task ID.

## Owning phase and preservation

Branch/worktree: `codex/pack-version-publication-p05b-ev-core` / `.worktrees/pack-version-publication-p05b-ev-core`. Root safely reuses the idle workflow-owned P05A directory/dependencies through a Git worktree move after stashing all ten source files and task records. Record that immutable stash before delegation. Original P05A branch/parent44e2f193 and immutable ten-file stashcd88d5c6 remain recoverable.

Current direct base: main `f678525141a55f4d7acbd82487a1871a94632096` (PR118, workflow skill records only). The metadata-only checkpoint was replayed from ef3c73e8 to `d168640d` before restoring source; backup `codex/p05b-before-main118-20260905` retains24e8d00f. Both semantic prerequisites are merged. No unmerged P03/P04/P07A code belongs in this independent phase.

Preservation completed: immutable stash `961f20694651e80c2e665f555bbce1e347dcc143` contains all ten partial source files plus records. The idle P05A worktree was clean after stashing and moved with `git worktree move` to P05B, retaining its relative workspace dependency links. The new branch starts exactly at mainef3c73e8; original P05A branch44e2f193 and both prior stashes remain unchanged. Only eight neutral files are restored; the two incomplete native economics files remain in the stash for011.

## Current verified implementation

Runtime `77c01707c6c8da9d886ebc316e1dc1fac8fda758` on direct mainf6785251. Source scope is9 authored files/+1,248/-1,081 (2,329 changed lines); the extra file is the dedicated public-entry/value regression. Root independently reran the complete44-file matrix:364/364 pass, zero skips (`/tmp/packscout-p05b-root-focused-20260905.log`). Contracts/services lint/types, boundaries and zero-finding ratchet pass. Root verified both648/238-line calculation bodies are byte-identical apart from the local import. The audit verifies16 moved public-value declarations and25 retained release declarations unchanged; neutral closure is nine local modules plus Zod, with no release DTO/server/database/provider/ambient-clock dependency.

Red missing-export test: `/tmp/packscout-p05b-neutral-core-red-20260905.log`; final agent focused/static/audit logs: `/tmp/packscout-p05b-neutral-core-{focused-final,static,audit}-20260905.log`. New tests cover public schema/function identity, canonical four-metric values, honest unavailable/vendor data, strict protected fields and stable errors. Incomplete native economics files remain absent and preserved in stash961f2069.

Full `npm run verify:framework` PASSED at exact head `5d710c3279cef2f0c07cc7bfe6df61ff613802f5`, runtime77c01707, parentf6785251, completed 2026-09-05 before04:36UTC. Log: `/tmp/packscout-p05b-framework-main118-20260905.log`. The unchanged runner reports28 existing opt-in skips: one distributed-database test,18 provider execution/protected-capture tests and nine local activation/repair/operator tests. None belongs to the neutral-core acceptance matrix; its364 focused tests all ran, and the full services maximum-catalog lane also ran separately. No skip flag, gate, timeout or baseline was changed. Both production builds passed. Delivery-only status records preserve this runtime proof and rerun the documentation gate. PR publication is next; no merge, deployment or full011 completion is claimed.

## Publication

PR https://github.com/dadriano/packscout/pull/121 is open and ready for review, independently based on mainf6785251. Root validated the live base/head (`a4139d6087f089b417c76947a4b0c1cedb6203d7`), non-draft state, exact parent ancestry, phase-only two-dot tree and four phase commits. Published scope25 files/3,153 changed lines: nine source/test files/2,329 plus16 task records/824. Only metadata exceeds the2,500-line target; no generated churn, below40files/5,000lines. A delivery-only record follows; no runtime changed after the certified full gate. Review/CI are not merge or launch approval.

## Requirements

- One browser-neutral exact rational calculator and confidence implementation; service exports reference the same functions, not copied implementations or wrappers.
- Move public value schemas without changing current validation, policy values, stable errors or protected-field behavior. Existing release consumers may import the same domain definitions; native V1 must not import release DTOs.
- Preserve payout order, exact final payouts, zero contribution without renormalization, draw multiplication, half-up cents/basis points, unavailable outcomes, confidence scoring/bands/reasons and freshness/expiry.
- No provider branching, network, persistence, wall-clock reads, credentials, data migration, API route, new flag or live activation.
- Exclude unfinished native economics schemas/tests, capture/readiness/snapshot wiring, query aggregates and frontend cutover;011/006/007 retain them.
- Fix new framework size/boundary findings with minimal responsibility-preserving splits; never weaken or baseline checks.

## Acceptance Criteria

- [x] Public domain/service entries identify the exact same calculator/confidence functions; deterministic fixtures pass.
- [x] Existing calculator, confidence, public EV, provider-derived values and protected-data regressions pass unchanged.
- [x] Formula/policy/error behavior matches the direct base; no release DTO or server-only dependency enters the neutral core.
- [x] Affected lint/types, framework guardrails and full `npm run verify:framework` pass on the exact parent/runtime.
- [x] Only the measured neutral boundary is committed/reviewable; incomplete011 work stays recoverable and later ownership is recorded.

## Verification

Named scenario: **One exact EV core for current consumers and native replay** — assert function/schema identity through public entries; replay canonical available/unavailable/confidence fixtures; run the complete existing calculator/confidence/public-value/provider-derived regression set; compare moved bodies with the direct base and prove browser-neutral import closure. Run the full framework gate before readiness.

No deploy applies to this pure domain refactor.011 owns immutable full-data parity;006 owns transaction-local capture/running publication;007 owns complete frontend/browser cutover;010 owns authorized launch.

## Spec Compliance

- Guidance: tech-001 native V1/clean-slate domain boundary plus011's approved unchanged-formula/full-data extension. No companion spec is edited.
- Delivery split only: shared domain behavior is not legacy response translation, dual reads/writes, another public catalog schema or provider-specific generic logic.
- Runtime77c01707 onf6785251 passes root364 focused regressions, affected static checks and the full framework gate at5d710c32. Preserving existing public consumer export names and errors imports the same domain values without a conversion layer, alternate read/write path or legacy DTO dependency. Published in PR121; no application activation applies to this phase.
