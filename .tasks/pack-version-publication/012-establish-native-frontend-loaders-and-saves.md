# Task: Establish Native V1 Frontend Loaders and Authoritative Saves

**ID:** pack-version-publication/012
**Depends on:** pack-version-publication/005
**Blocks:** pack-version-publication/007
**Delivery phase:** P07A
**Estimated scope:** medium
**Status:** in_progress

## Current auth-refresh review — 2026-09-05 15:02UTC

Repair is committed/replayed as `3d134eb0a17cd6cfc6aff4825b68f559d32e7942` on merged121 parent `0ea6145470a276807a0e9590d759d9fad85e9226`. All four phase source patches replay identically; backup `codex/p07a-before-main121-20260905` retains3b8d2e9e. Loading preserves coordinator generation and disables new UI actions, while terminal auth, identity-key remount and unmount still dispose. Root654/654 complete frontend tests pass, zero skips (`/tmp/packscout-p07a-refresh-main121-frontend-20260905.log`); agent112 focused/64 actual-component lifecycle tests, lint/types/boundaries/ratchet0 pass. Independent review found no actionable issue. Full local verifier is running at this runtime (`/tmp/packscout-p07a-refresh-main121-framework-20260905.log`); fresh CI and fixing-SHA reply remain before acceptance. No frontend tree change during restack; no dependency, copy, layout or activation change.

PR120 P2comment3940423155 invalidates pending-write continuity: same-user auth refresh maps status to loading, causing signedIn-dependent cleanup to dispose the coordinator and discard an already-issued mutation's success/refusal. Agent p07_auth_refresh owns the existing provider/lifecycle-test repair; preserve layout-effect activation, duplicate suppression, authoritative reconciliation, true sign-out/identity/unmount isolation and existing UI/copy. Full current-head CI33962882050 passed e08198a7, but cannot certify this new repair. User has approved merge after checks/reviews clear; no further merge question is needed for120.

## Current certification — 2026-09-05 11:00UTC

Full [framework CI33960130659](https://github.com/dadriano/packscout/actions/runs/33960130659) PASSED on exact head `d0a45b2f0b593c6da69d062519f9078c9e561974`, runtime `77965267f364cbfb94dbf1e6f3dc13d10e9dd217`, parent `f678525141a55f4d7acbd82487a1871a94632096`, completed11:00:22UTC. Root verified the live head/base and success. All594 frontend tests and14 targeted Convex capacity tests pass without skips; the unchanged full CI retry succeeds without weakening tests or timeouts. The activation review thread is replied/resolved and the bot reviewed this exact head with a thumbs-up. Task012 is done; PR120 is open and ready for human review, not approved or merged. Delivery-only records do not change this certified runtime and receive the documentation gate.

## Earlier save-activation review

Published head d0a45b2f/runtime77965267 is replied3940256472 and the activation thread is resolved; bot review completed this exact head with a thumbs-up. FullCI33960130659 failed only the unchanged Convex1000-pack capacity test at its30-second timeout, before the sequential runner reached frontend tests. No Convex source/test/config changed. Root's targeted current-head rerun passed14/14 in13.28seconds (`/tmp/packscout-p07a-ci-capacity-recheck-20260905.log`) and the failed CI job was retried once without weakening a test or timeout. CI must finish successfully before012 is done; the precise cause of runner variance is not proven.

Repair committed as `77965267f364cbfb94dbf1e6f3dc13d10e9dd217` on mainf6785251. No source change after root594-test pass. Synchronizing canonical delivery records and publishing to existing PR120 for fresh exact-head framework CI; keep012 in_progress until that gate passes.

PR120 P2comment3939522777/threadPRRT_kwDOTplTZc6fgZWg is repaired locally by activating/disposing the existing mutation coordinator in the layout effect. Real ReactDOM tests mount the actual provider/buttons/Convex hooks with only transport/cache stubbed, remount with cached IDs and click during an ancestor layout effect before passive effects. All four pack/collectible save/remove cases failed before repair and pass afterward; duplicates remain single writes, pending state stays disabled and only authoritative reads change saved truth/success.

Agent52 focused tests, frontend lint/types/boundaries and ratchet0 pass. Root independently ran all594 frontend tests, zero skips/quarantines (`/tmp/packscout-p07a-save-activation-root-frontend-20260905.log`), checked dependency policy and reviewed the actual-component test and provider diff. Independent review found no actionable issue. The frontend skill preserved existing interaction/accessibility/copy; no visual or route changes. Frontend owns its jsdom26.1.0/types21.1.7 test dependencies;16 lock entries relocate with identical existing versions/integrities, no production dependency update. Old fullCI33946425977 passed6ba5bfb0/runtime35ef3d75; commit/publication and new full-gate certification remain required for this repair.

## Earlier full-gate certification

Full [framework CI33944611792](https://github.com/dadriano/packscout/actions/runs/33944611792) PASSED at exact head `a0457a13c951a91cd51b75c48bfda08f7efde025`, runtime35ef3d75, parent `f678525141a55f4d7acbd82487a1871a94632096`, completed2026-09-05 04:51:20UTC. Root verified the live conclusion/head, parent ancestry and unchanged frontend runtime. All current acceptance criteria are complete. The request-ID thread is replied/resolved and the bot explicitly reviewed that exact head with a thumbs-up. PR120 remains ready for review, not merged; fresh human merge approval is required. Subsequent delivery-only records rerun docs without changing the certified runtime. No catalog route or production writer activates here.

## Earlier request-identity review repair

PR120 P2comment3939406332/threadPRRT_kwDOTplTZc6fgGzj is fixed in runtime `35ef3d75f8cdd5617dcadf959a98fbe57a96fbba` on mainf6785251. Successful getPublicPack and desired-collectible responses must match the parsed stable ID; mismatches return existing bounded CATALOG_UNAVAILABLE, including after the one cursor reset. Root reviewed the two-file diff and reran all five task-focused files:48/48 pass, zero skips, `/tmp/packscout-p07a-identity-root-focused-20260905.log`. Frontend lint/types/ratchet pass. Direct red regression log: `/tmp/packscout-p07a-request-identity-red-20260905.log`. Loader acceptance is reverified; exact repaired-head full gate and fixing-SHA review reply remain pending. Previous gate/thumbs-up do not certify this new runtime.

Published at a0457a13. Reply3939440289 cites35ef3d75 and the request-ID thread is resolved. The bot explicitly reviewed a0457a13 with a thumbs-up. FullCI33944611792 is still pending; only that current-head gate remains before acceptance recertification, not the already-completed reply.

## Earlier main118 recertification

Main advanced through workflow-records-only PR118 tof678525141a55f4d7acbd82487a1871a94632096. Root restacked the phase onto that parent: runtime9459611d, checkpointa19a2628. All eight phase patches match their prior versions; `git diff c6267a71 HEAD -- apps/frontend` is empty. Backup `codex/p07a-before-main118-20260905` retainsc6267a71. The previous full CI33937038465/independent review remain valid historical implementation evidence, and the PR received an explicit bot thumbs-up for083ad937. Parent-specific full gate must be refreshed before merge readiness; task012 is in_progress only for recertification, not new runtime work. No catalog switch or live operation occurs.

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
- [ ] Saved-item success/failure/prune/duplicate/concurrent/session-change behavior has direct tests.
- [x] Saved membership remains server-authoritative and pending labels describe the requested action without changing pressed state.
- [x] Every native saved refusal remains bounded and existing suspended-account behavior is preserved.
- [x] Existing frontend routes and data points remain unchanged; the V1 loader is dormant until task007.
- [ ] Full frontend tests, lint/types, framework ratchet, and `npm run verify:framework` pass on the owning phase head.
- [x] The measured phase-only diff is reviewable and committed; final evidence and later acceptance ownership are recorded.

## Verification

Named scenario: **Native reader and authoritative save foundation** — exercise all six native action references, malformed output, absent configuration, authorization refusals and one cursor reset; concurrently save/remove stable identities through successful/pruned/refused/malformed results; dispose and reactivate sessions while requests are pending and prove stale completions cannot alter current UI state.

Focused files: `pack-catalog.server.test.ts`, `public-repacks.server.test.ts`, `saved-item-mutations.client.test.ts`, `saved-item-presentation.test.ts`, and `account-standing.test.ts`. The final full frontend runner discovers all tests automatically.

## Spec Compliance

- Current runtime35ef3d75 onmainf6785251 is certified by fullCI33944611792 at a0457a13. Root48 direct task tests, affected static checks and current bot review also pass; the older evidence below is retained as history.

- Related guidance reviewed: tech-001 and tech-004 (task007 shared scope), frontend baseline, UI layout, and shift-left BDD.
- Boundary split only: no technical companion file is changed and no product outcome is removed.
- Task007 retains all six visible journeys, route/query state, full data inventory, Watchlist/chase projection migration, and desktop/narrow browser verification.
- The foundation changes pure reader/state behavior and existing save controls, not navigation, layout, authenticated routing, or catalog visibility. Direct state/security tests are required; the full catalog browser flow belongs to007.
- Full framework CI33937038465 passed at083ad937 on parentef3c73e8. The ENOSPC run and the deliberately interrupted pre-repair run remain historical failures, not passing gates.
- Final independent code/test review confirms exactly six strict action references, server-only credentials, bounded unavailable/errors, one affected-cursor reset, bounded authoritative identifiers,500 pending/50 message limits, all native refusals, capacity pruning and generation/session cancellation. Production imports confirm the V1 loader is dormant; no route/query-state/Watchlist projection/CSS/telemetry changed. Existing guest Save copy and suspended refusal are preserved.
- Known-suspended Save clicks still reach the existing native mutation and display its bounded refusal; no new disabled-control design was introduced. The account-wide notice and availability state are unchanged.
- Latest evidence: 42 focused tests pass in `/tmp/packscout-p07a-suspended-toggle-focused-20260904.log`; all 577 frontend tests pass with zero skips in `/tmp/packscout-p07a-suspended-toggle-frontend-20260904.log`; frontend lint/types pass in `/tmp/packscout-p07a-suspended-toggle-static-20260904.log`.
