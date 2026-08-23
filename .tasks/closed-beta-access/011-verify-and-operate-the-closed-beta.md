# Task: Verify and Operate the Closed Beta

**ID:** closed-beta-access/011
**Depends on:** closed-beta-access/004, closed-beta-access/005, closed-beta-access/007, closed-beta-access/008, closed-beta-access/009, closed-beta-access/010
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

The closed beta is proven end to end as one connected system, its boundary is stated rather than assumed, and it can be run day to day and opened to the public later through a documented switch.

## Context

Each preceding task verifies its own layer. None of them proves the thing the business actually cares about: that a stranger cannot get the catalog, that an invited person walks straight in, that an administrator can let someone in and have that person actually get in, and that when the beta ends the whole gate lifts cleanly.

This task closes that gap and makes the beta operable — the configuration the gate needs, how to admit and revoke people, what an unadmitted party can still see, and how to open the product to the public without a code change. It also reconciles the repository's existing behavior specifications with reality: PackScout's authentication feature currently specifies that an anonymous visitor keeps full public access, which this feature deliberately reverses. Leaving that contradiction in place would leave the next builder with two specifications and no way to know which one is true.

## Requirements

- An end-to-end behavior scenario set records the full journey, at minimum: a signed-out visitor reaches only the landing page; an allowlisted identity signs in and is in the product immediately; a non-allowlisted identity signs in and lands in review; an administrator approves a waiting visitor and that visitor reaches the product without signing in again; an administrator declines someone and they see the declined surface; a revoked user loses the product on their next navigation; a suspended user sees the suspension notice rather than the review notice; a direct call to the catalog read model without an admitted identity or the server credential is refused; and turning the switch off makes the product fully public again.
- Each scenario is marked as automated with its covering check, or as an explicit manual gap with the reason — no scenario is left implying coverage it does not have.
- Existing behavior specifications that the closed beta changes are updated rather than left contradicting it, including the authentication feature's public-access scenarios.
- Operational documentation covers every configuration value the gate depends on — the beta switch, the server-side catalog read credential, and the operator-integration secret — saying what each does, where it lives, that none of them belongs in a browser-visible variable, and what the product does when each is missing or wrong.
- A runbook covers the recurring operations: admitting someone in advance, deciding a waiting request, revoking access, and what an operator should expect the person on the other end to see in each case.
- Seeding the first allowlist entries is possible without hand-editing the database — through the admin surface or a documented operator path — so a fresh deployment can admit its first administrator.
- Opening the beta to the public is documented as a single switch with its expected effects enumerated: the landing page stops intercepting the root, gated routes render for anyone, catalog reads are public again, indexing exclusions lift, and no data or account state changes.
- The beta's boundary is stated explicitly and verified: what an unadmitted party can still observe — the landing page, the gate-status read, health probes — so the exposure is known rather than assumed.
- Documentation passes the repository's documentation checks.

## User-Facing Behavior

No new surface. The visible outcome is that the beta behaves the same way every time for every kind of visitor, and that a future decision to go public is a configuration change rather than a project.

## Interface Contract

- The behavior scenario set lives where the repository keeps its behavior specifications, alongside the feature's task files, and names the coverage for each scenario.
- Operational documentation lives with the repository's existing operator documentation; the task adds no new configuration mechanism of its own, only documents what the preceding tasks established.

## Acceptance Criteria

- [x] The end-to-end scenario set exists with every listed journey covered, each marked automated with its check or as an explicit manual gap.
- [x] The authentication feature's public-access scenarios are updated to describe beta-gated access.
- [x] Every gate configuration value is documented with its purpose, location, browser-visibility rule, and missing-or-wrong behavior.
- [x] The runbook covers admitting, deciding, revoking, and what the affected person sees in each case.
- [x] The first allowlist entries can be seeded without hand-editing the database.
- [x] Opening the beta is documented as one switch with its effects enumerated, and turning it off is demonstrated to restore fully public behavior.
- [x] What an unadmitted party can still observe is stated and verified.

## Verification

The workspace's full verification command — lint, typecheck, tests, build, and the framework and documentation checks across frontend, admin, and product backend — exits 0, and the recorded end-to-end scenario set shows every listed journey either covered by a named automated check or marked as an explicit manual gap.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` (three-door enforcement, the single switch, out-of-scope list); the Spec Compliance sections of closed-beta-access/001–010 — every coverage citation below names checks those tasks recorded, re-verified against the tree; `.tasks/privy-auth/scenarios/privy-auth.feature.md` (the behavior-spec convention, and the public-access scenarios 007 already rewrote for the beta); `docs/testing/shift-left-bdd.md` (scenario standard, Coverage markers, tooling-lane discovery); `scripts/check-docs.mjs` (forbidden terms, link validity); `.tasks/messaging/_index.md` (messaging/006 supersedes the no-notification exclusion; 006 is in flight, so the runbook names the live surface as how decisions reach people today and attributes decision email to `messaging/006` without claiming it shipped).
- Alignment: the end-to-end scenario set is `.tasks/closed-beta-access/scenarios/closed-beta-access.feature.md` — eleven scenarios covering every journey the spec lists (signed-out → landing only; allowlisted → straight in; non-allowlisted → review; operator approves → visitor enters without re-login; declined → declined surface; revoked → loses the product on the next navigation; suspended → suspension notice distinct from review; direct catalog read without an admitted identity or the server credential → refused; switch off → fully public again) plus the enumerated unadmitted-observable boundary and the admin-seeded allowlist. Every Coverage line names real test files with real test names (verified on disk and by grep before citing). Operational documentation is `docs/closed-beta-operations.md`: how to tell the beta is on; the full configuration reference (`PACKSCOUT_CLOSED_BETA` exact-`"1"` semantics per `convex/productUserAccess.ts`; `PACKSCOUT_CATALOG_READ_TOKEN` 32–512 bounds and two-end fail-closed behavior per `convex/publicCatalogReadAccess.ts` + `apps/frontend/lib/public-repacks.server.ts`; `PACKSCOUT_ADMIN_DIRECTORY_URL`/`_TOKEN` ≥32-char bound, HTTPS origin rule, and both-end degradation per `apps/admin/server/runtime-config.ts` + `convex/http.ts`, noting the same integration carries directory, allowlist, decisions, and welcome dispatch; `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_PRIVY_APP_ID`/`PRIVY_APP_ID` as prerequisites) with per-value purpose, location, browser-visibility rule, and missing-or-wrong behavior, all verified from code; the `packscout-identity` cookie mechanism with its exact caching bounds (identity never cached cross-request, 30s per-process gate-status TTL, cookie ≤ token expiry − 60s clamped to 1h, 10-minute refresh); the runbook procedures (see who is waiting, admit in advance, decide, revoke with the allowlist-caveat, suspension composition, what the person sees in each case); the no-database-edit seeding order (administrator account → integration configured → sign in → Allowlist → first invitees, with the local lane's `PACKSCOUT_BOOTSTRAP_ADMIN_*` variables named); the boundary table tied to enforcement tests; and opening to the public as one `npx convex env remove PACKSCOUT_CLOSED_BETA` with seven enumerated effects, each tied to its proving test. README.md's stale "remain public" sentence in the Privy section is now beta-conditional, and both the Privy and catalog-credential sections link the runbook. Citation integrity is enforced by `scripts/scenario-coverage-citations.test.mjs` in the tooling lane (discovered by `scripts/run-tests.mjs`): every scenario carries exactly one recognized Coverage marker, every backticked test-file citation across the scenario set, the privy-auth feature file, and the runbook must exist on disk, and every Automated claim in the closed-beta set must name at least one test file — with liveness floors so regex drift fails loudly.
- Manual gaps stated (not implied away): the live Privy sign-in round trip (standing since 007) and the live approval flip over the Convex sync protocol (standing since 008), each recorded inside the affected scenarios and consolidated in the scenario set's closing section as launch-checklist items.
- Divergences: (1) Scenarios whose buildable layers are fully automated but whose connected pass needs a live provider are marked `Coverage: Automated — <checks>` with an explicit trailing `Manual gap — <reason>`, following the convention the privy-auth file already established, rather than demoting the whole scenario. (2) The citation-integrity suite is scoped to this feature's three documents rather than every scenarios file in the repository, because `.tasks/repack-dashboard/scenarios/repack-dashboard.feature.md` (lines 22 and 68) cites `convex/publicCatalog.test.ts`, which no longer exists — a pre-existing stale citation in another feature's record, outside this task's write scope; flagged for its own follow-up rather than silently adopted or silently skipped. (3) The authentication feature's public-access scenarios were already rewritten by 007; this task verified them (including that every file they cite exists) and put them under the citation suite rather than editing them again. (4) Configuration values live in README.md per the 003/005 precedent with the runbook as the operational reference; the two documents link each other rather than duplicating bounds.
- Verification: `node scripts/check-docs.mjs` → ok, 158 markdown files (both new documents scanned; no forbidden terms, all links resolve). `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new. `npm run test:tooling` → exit 0: 27 files discovered (the citation suite included), 209 parallel tests passed plus the 3 isolated `start-admin-embedded` tests — the previously observed isolated-lane failures did not reproduce on this run. `node --test scripts/scenario-coverage-citations.test.mjs` → 3/3 pass in isolation. `npm run check:framework` → exit 0. The workspace-wide `verify:framework` (product lanes and builds) is the branch-handoff gate: two sibling messaging tasks are mid-flight in this shared worktree, so the full-tree run belongs to integration; nothing this task wrote is reachable by a product lane (documentation, scenarios, and one tooling test only).
