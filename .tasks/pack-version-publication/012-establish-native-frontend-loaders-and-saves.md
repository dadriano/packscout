# Task: Establish Native V1 Frontend Loaders and Authoritative Saves

**ID:** pack-version-publication/012
**Depends on:** pack-version-publication/005
**Blocks:** pack-version-publication/007
**Delivery phase:** P07A
**Estimated scope:** medium
**Status:** done

## Current main116 recertification

The phase is cleanly restacked onto main `ef3c73e8bb61ade6907dc2abd67751523ae026bd` (PR116), runtime990bafe4/certified head083ad937. Full [framework CI33937038465](https://github.com/dadriano/packscout/actions/runs/33937038465) PASSED on this exact head and parent. Independent final acceptance review found no actionable issues and confirmed every criterion below. PR120 is now ready for review, not approved or merged. This delivery-record-only update changes no runtime or tests; the documentation gate is rerun before commit. No visible catalog switch or live data operation.

Measured before this evidence update:29 authored files/1,803 changed lines, of which14 frontend files/1,100 lines and15 requested canonical task records. The documented metadata-only file-target exception remains below40files/5,000lines. All six restack patches match their earlier parent; backup `codex/p07a-pre-main116-with-context-20260904` retains prior history. Earlier main117 evidence:584/584 tests across99 files, zero skips/quarantines, lint/types/ratchet/docs, `/tmp/packscout-p07a-main117-focused-20260904.log`. The exact-current-parent full CI supersedes historical pending/failure notes below.

## Historical main117 recertification

Current direct parent is `8616bfd5041f490a0334ca4beef2a2e4f26ed88e` (PR117). Runtime5428ddeb, checkpoint1cd2ba7b; all four phase patches match the previous parent exactly. Backup `codex/p07a-before-main117-restack-20260904` retains3f8b180e. [PR120](https://github.com/dadriano/packscout/pull/120) is an explicitly unfinished draft for the unchanged GitHub full gate. Fresh frontend checks must preserve PR117's visual and anonymous-Save copy changes; full exact-parent certification remains pending.

## Scope and reason for the split

This is the measured merge-safe foundation split from task007, not completion of its frontend cutover. The user requires every current frontend data point. The14-file,1,067-line loader/save slice can be reviewed and verified without exposing an incomplete catalog. Task007 retains the atomic consumer switch and full browser acceptance; task011 retains native data completeness. No operation-by-operation coexistence of old and V1 catalog journeys is introduced.

## Active build

Worktree: `.worktrees/pack-version-publication-p07-frontend`.
Branch: `codex/pack-version-publication-p07a-frontend-foundation`.
Current direct base: main `70bbae98a35b16dde20a5b152bab5a371aebeeae`. Clean restack fromcd9c2da8 preserves both range-diff patches exactly. Runtime is now `6556b990`, checkpoint `f9fe160c`; backup `codex/p07a-before-main115-restack-20260904` retainsfb7e4d5d.
Runtime checkpoint: `46a254379423bc5fd4664a8676ad1db8127eeab4`. Independent review found and fixed a known-suspended account's silent Save no-op by preserving authoritative mutation refusal. All 577 frontend tests and affected lint/types pass. The final full gate exited1 in tooling with 43 failures amid ENOSPC; earlier product/static lanes passed, but no complete gate is certified. Log: `/tmp/packscout-p07a-framework-final-20260904.log`. After disk recovery, rerun the full gate on the new parent. No PR or deployment is claimed.

## Objective

Current-main focused verification PASSED:578/578 frontend tests across98 files, zero skips/quarantines; frontend lint/types, zero-finding ratchet and316-file docs check all pass. Log: `/tmp/packscout-p07a-main115-focused-20260904.log`. Host disk pressure prevents another reliable local full gate; an explicitly unfinished draft PR will run the unchanged GitHub full framework gate with PostgreSQL16. Full acceptance and ready-for-review delivery remain pending that exact-head result.

Provide strict server-side readers for the six native V1 operations and preserve authoritative saved-item state through refusals, duplicate intent, capacity pruning, and session changes. Keep every visible catalog route on its unchanged current contract until task007 can switch all consumers together.

## Requirements

- Exactly the six `api.packCatalogV1` action references; validate both inputs and outputs.
- One shared server-only catalog-origin and credential boundary; no browser credential access or old-response-to-V1 adapter.
- Stable bounded unavailable/auth/query errors; no backend exception strings exposed.
- A cursor-expired page may reset only that operation's cursor once, preserving the remaining query and stable selection. A second expiry is returned.
- Continue using only the existing three native saved-item operations.
- Validate native saved identifiers and mutation results; suppress synchronous duplicate clicks.
- Never optimistically assert saved membership. Display success only after the bounded authoritative identifier read agrees with the mutation result, including capacity prune.
- Preserve each typed refusal message, account-standing behavior, pending action labels, and exact saved/pressed server truth.
- Cancel stale asynchronous completion on disposal/sign-out; existing authenticated-identity keying remounts the coordinator when users change.
- Bound pending work and message history.
- No catalog route switch, query-feature reduction, Watchlist projection migration, auth bypass, or production writer activation.

## Acceptance Criteria

- [x] All six operation references, input/output validation, credential handling, bounded errors, and cursor recovery have direct focused tests.
- [x] Saved-item success/failure/prune/duplicate/concurrent/session-change behavior has direct tests.
- [x] Saved membership remains server-authoritative and pending labels describe the requested action without changing pressed state.
- [x] Every native saved refusal remains bounded and existing suspended-account behavior is preserved.
- [x] Existing frontend routes and data points remain unchanged; the V1 loader is dormant until task007.
- [x] Full frontend tests, lint/types, framework ratchet, and `npm run verify:framework` pass on the owning phase head.
- [x] The measured phase-only diff is reviewable and committed; final evidence and later acceptance ownership are recorded.

## Verification

Named scenario: **Native reader and authoritative save foundation** — exercise all six native action references, malformed output, absent configuration, authorization refusals and one cursor reset; concurrently save/remove stable identities through successful/pruned/refused/malformed results; dispose and reactivate sessions while requests are pending and prove stale completions cannot alter current UI state.

Focused files: `pack-catalog.server.test.ts`, `public-repacks.server.test.ts`, `saved-item-mutations.client.test.ts`, `saved-item-presentation.test.ts`, and `account-standing.test.ts`. The final full frontend runner discovers all tests automatically.

## Spec Compliance

- Related guidance reviewed: tech-001 and tech-004 (task007 shared scope), frontend baseline, UI layout, and shift-left BDD.
- Boundary split only: no technical companion file is changed and no product outcome is removed.
- Task007 retains all six visible journeys, route/query state, full data inventory, Watchlist/chase projection migration, and desktop/narrow browser verification.
- The foundation changes pure reader/state behavior and existing save controls, not navigation, layout, authenticated routing, or catalog visibility. Direct state/security tests are required; the full catalog browser flow belongs to007.
- Full framework CI33937038465 passed at083ad937 on parentef3c73e8. The ENOSPC run and the deliberately interrupted pre-repair run remain historical failures, not passing gates.
- Final independent code/test review confirms exactly six strict action references, server-only credentials, bounded unavailable/errors, one affected-cursor reset, bounded authoritative identifiers,500 pending/50 message limits, all native refusals, capacity pruning and generation/session cancellation. Production imports confirm the V1 loader is dormant; no route/query-state/Watchlist projection/CSS/telemetry changed. Existing guest Save copy and suspended refusal are preserved.
- Known-suspended Save clicks still reach the existing native mutation and display its bounded refusal; no new disabled-control design was introduced. The account-wide notice and availability state are unchanged.
- Latest evidence: 42 focused tests pass in `/tmp/packscout-p07a-suspended-toggle-focused-20260904.log`; all 577 frontend tests pass with zero skips in `/tmp/packscout-p07a-suspended-toggle-frontend-20260904.log`; frontend lint/types pass in `/tmp/packscout-p07a-suspended-toggle-static-20260904.log`.
