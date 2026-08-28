# Task: Activate and Certify ClutchPacks

**ID:** last-known-ev-confidence/006
**Depends on:** last-known-ev-confidence/002, last-known-ev-confidence/003, last-known-ev-confidence/004, last-known-ev-confidence/005
**Blocks:** none
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including canary, browser proof, and rollback evidence
**Status:** done

## Start Here

Run a dry-run from the existing local ClutchPacks canonical revisions, confirm that a newly assembled release retains its known estimates as last-known without source reimport, and record the before/after availability counts before activation.

## Objective

The isolated `shiny-newt-310` Convex deployment and local frontend prove the approved policy from existing canonical evidence through browser presentation.

## Context

ClutchPacks is the bounded test provider. Its canonical import is complete and all 17 current V1 revisions are reusable. The old active Convex release was assembled under the retired expiry behavior, so this rollout must publish a new release from those existing local revisions; it does not reimport provider data. Neon remains out of scope.

## Requirements

- Deploy the versioned public policy and provider-health path to the isolated test deployment.
- Reuse existing ClutchPacks canonical and release evidence; do not run a provider reimport.
- Publish or refresh an authenticated provider observation reflecting the source's actual paused or healthy state.
- Verify availability counts, confidence samples, sorting, Top Opportunities eligibility, and detail parity.
- Preserve a tested rollback to the previously active public behavior or deployment.

## User-Facing Behavior

The local frontend shows existing ClutchPacks economics as current or last-known, never age-expired unavailable. If the source remains paused, every known EV stays visible while Top Opportunities explains its exclusion.

## Interface Contract

Certification records the active release identity, public freshness-policy version, provider-observation identity, evaluation time, count reconciliation, representative pack fingerprints, and browser evidence without exposing protected source data.

## Acceptance Criteria

- [x] ClutchPacks known EV becomes visible from the existing canonical revisions in the newly assembled active release without provider reimport.
- [x] Sample scores match the approved curve and one pinned server evaluation time.
- [x] Provider health affects Top Opportunities only and matches the real source state.
- [x] Catalog, overview, sort, inspector, glossary, and Learn flows pass browser verification with screenshots.
- [x] Focused tests and `npm run verify:framework` pass before handoff.

## Verification

Completed certification:

- Convex target: isolated deployment `shiny-newt-310`; Neon was not used.
- Active release: `a83304bd-ca54-88bc-8c6f-7abb4bfae796`.
- Release fingerprint: `e0941b016fca5e7fb5dbe57674c60e8e662e6a935900290b210d85c0db9a418e`.
- Rollback predecessor: `dda5db8a-cbd4-86e9-8678-802977c4ce53`.
- Reconciliation: 17 repacks, 10 categories, 6,442 collectibles, 8,130 chases, and 1 search shard; public read-back returned all 17 repacks and all detail/search probes passed.
- EV presentation: 15 last-known estimates remain visible with confidence scores from 4,701 through 4,980; 2 estimates remain deterministically unavailable for non-age reasons; no positive EV is displayed.
- Provider observation matches the actual paused source lifecycle, so all 15 known estimates are provider-ineligible for Top Opportunities while remaining visible in All Repacks; Top Opportunities correctly returns 0.
- Source: all 17 existing local canonical revisions were reused. No provider reimport, PostgreSQL mutation, or Neon migration was performed.
- Verification: contracts 317 tests, services 1,146 tests, Convex 340 tests, frontend 458 tests, and promotion/preproduction 65 tests passed. The complete `npm run verify:framework` gate passed, including production builds.
- Browser: overview, catalog cards/table, confidence sort, inspector, keyboard dismissal, both themes, mobile/200%-equivalent reflow, glossary/Learn copy, and console-error checks passed. Screenshot proof is retained with the task artifacts.

## Spec Compliance

This rollout changed public freshness presentation without changing immutable V1 economics. It used the existing local canonical revisions, deployed only to the isolated Convex database, preserved an explicit predecessor for rollback, reflected the provider's real paused state, and kept Neon deferred.
