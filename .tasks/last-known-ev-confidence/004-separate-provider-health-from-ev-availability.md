# Task: Separate Provider Health From EV Availability

**ID:** last-known-ev-confidence/004
**Depends on:** last-known-ev-confidence/001
**Blocks:** last-known-ev-confidence/005, last-known-ev-confidence/006
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder, including signed refresh and ranking tests
**Status:** done

## Start Here

Write the fail-closed ranking matrix first: healthy and aligned may rank; missing, stale, paused, unhealthy, behind-head, or release-misaligned remains visible but cannot enter Top Opportunities.

## Objective

Provider operations can change independently of immutable catalog releases, and only trustworthy provider observations authorize Top Opportunities ranking.

## Context

The current public release has no independently refreshable provider-health state. Evidence age is not a substitute: old but healthy data and newly published data from a paused source have different operational meaning.

## Requirements

- Store bounded provider observations separately from immutable release documents.
- Bind each observation to the exact active release and public vendor identity.
- Accept only authenticated, monotonic, idempotent updates with active-release compare-and-swap checks.
- Track observation time, freshness horizon, head/settled proof, lifecycle, connection, quality, and release alignment.
- Fail closed for Top Opportunities only; preserve EV visibility, ordinary sorting, and detail access.

## User-Facing Behavior

When a provider feed is delayed or paused, buyers still see its last-known EV and source age, plus `Provider feed delayed; excluded from Top Opportunities.`

## Interface Contract

A provider observation reports one bounded eligibility decision and reason derived from authenticated operational facts. Public reads expose only sanitized health state, observation time, the trusted server time at which health was evaluated, and ranking eligibility. Cursor-pinned confidence never extends the provider-health freshness window. Provider payloads, internal checkpoints, and credentials never cross the boundary.

## Acceptance Criteria

- [x] Healthy, fresh, aligned, at-head observations allow otherwise eligible packs to rank.
- [x] Missing, stale, paused, unhealthy, behind-head, and release-mismatched observations exclude packs only from Top Opportunities.
- [x] Replay is idempotent; sequence regression, invalid signature, and active-release mismatch fail closed.
- [x] Activating a new release invalidates old health authorization until an aligned refresh arrives.
- [x] The current paused ClutchPacks source can remain visible while excluded from Top Opportunities.

## Verification

Run focused health-contract, authenticated-boundary, release-switch, and ranking tests before completing this task.

## Spec Compliance

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: provider observations are independently signed, monotonic, release-bound, and sanitized. Public health affects Top Opportunities only, exposes the next eligible-provider boundary, and never changes EV availability, ordinary sorting, medians, coverage, or details.
- Divergences: none.
- Verification: contract tests passed 317/317, full Convex tests passed 340/340, signed promotion/preflight tests passed 65/65, and the real ClutchPacks canary audit proved its 15 known estimates remain visible while health can fail closed for ranking.
