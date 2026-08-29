# Task: Evaluate Stable Dynamic Confidence

**ID:** last-known-ev-confidence/003
**Depends on:** last-known-ev-confidence/001, last-known-ev-confidence/002
**Blocks:** last-known-ev-confidence/005, last-known-ev-confidence/006
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder, including query, cursor, aggregate, and adversarial clock coverage
**Status:** done

## Start Here

Write one search test that crosses the 60-minute boundary and prove the same pack keeps its EV, changes to `last_known`, and appears exactly once across confidence-sorted pagination.

## Objective

Public queries derive one trustworthy presentation confidence per response without unstable sorting, caller-controlled freshness, or mutation of the stored release.

## Context

Confidence now changes with time. If every page evaluates at a different clock, confidence sorting can reorder rows and produce duplicates or omissions. The query boundary must therefore own and pin evaluation time.

## Requirements

- Evaluate every row, detail, aggregate, and band in one response at one trusted timestamp.
- Store the first page's evaluation timestamp inside the opaque cursor for confidence-sorted pagination.
- Reuse the pinned timestamp for later pages and reject tampered, expired, release-mismatched, or query-mismatched cursors.
- Keep ordinary EV sorting available for current and last-known estimates.
- Freeze sold-out confidence at sellout and retain existing non-ranking behavior.

## User-Facing Behavior

Lists do not lose values at 60 minutes, confidence ordering remains stable while paging, and a detail view agrees with the row and overview generated in the same response.

## Interface Contract

Every public response identifies the public freshness-policy version and `confidenceEvaluatedAt`. Responses carrying provider health also identify the independently server-minted `providerHealthEvaluatedAt`; cursor pagination pins only confidence, while health is reevaluated at the current trusted action clock. A confidence-sort cursor binds release identity, query fingerprint, sort direction, offset, and the pinned confidence timestamp. The trusted boundary supplies both clocks; public callers cannot select either one.

## Acceptance Criteria

- [x] Crossing 60 minutes changes presentation state without changing availability or economics.
- [x] Search, detail, aggregates, and confidence bands use one timestamp per response.
- [x] Confidence-sorted multi-page results contain no duplicates or omissions while scores decay.
- [x] Tampered clocks and cursors fail with bounded structured errors.
- [x] Positive suppression and sold-out historical behavior remain unchanged.

## Verification

Run focused Convex/public-query tests, cursor adversarial tests, and typecheck before completing this task.

## Spec Compliance

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: trusted public actions mint the response clock, confidence pagination binds its first-page clock in a signed opaque cursor, and provider health uses a distinct current server clock so opening a later page cannot extend health freshness. Search, details, aggregates, sold-out history, positive suppression, and the full retained 1,000-row compatibility bound are covered.
- Divergences: none.
- Verification: full Convex suite passed 340/340, Convex typecheck passed, and the contract suite passed 317/317.
