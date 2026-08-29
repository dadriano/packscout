# Task: Separate Provider Health From EV Availability

**ID:** last-known-ev-confidence/004
**Depends on:** last-known-ev-confidence/001
**Blocks:** last-known-ev-confidence/005, last-known-ev-confidence/006
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder, including signed refresh and status tests
**Status:** done

## Start Here

Write the informational status matrix first: healthy, delayed, and unavailable health states are disclosed, but none may hide or exclude otherwise rankable EV.

## Objective

Provider operations can change independently of immutable catalog releases, so PackScout discloses trustworthy provider observations without using them as a ranking gate.

## Context

The current public release has no independently refreshable provider-health state. Evidence age is not a substitute: old but healthy data and newly published data from a paused source have different operational meaning.

## Requirements

- Store bounded provider observations separately from immutable release documents.
- Bind each observation to the exact active release and public vendor identity.
- Accept only authenticated, monotonic, idempotent updates with active-release compare-and-swap checks.
- Track observation time, freshness horizon, head/settled proof, lifecycle, connection, quality, and release alignment.
- Fall back to informational unavailable health when an observation is missing or malformed; preserve EV visibility, Top Opportunities, ordinary sorting, and detail access.

## User-Facing Behavior

When a provider feed is delayed or paused, buyers still see its last-known EV and source age, plus `Provider feed delayed; displaying the latest available data.`

## Interface Contract

A provider observation reports one bounded informational state and reason derived from authenticated operational facts. Public reads expose only sanitized health state, observation time, and the trusted server time at which health was evaluated. Cursor-pinned confidence never extends the provider-health freshness window. Provider payloads, internal checkpoints, and credentials never cross the boundary.

## Acceptance Criteria

- [x] Healthy, fresh, aligned, at-head observations are disclosed as healthy.
- [x] Missing, stale, paused, unhealthy, behind-head, and release-mismatched observations remain informational and do not exclude packs from Top Opportunities.
- [x] Replay is idempotent; sequence regression, invalid signature, and active-release mismatch fail closed.
- [x] Activating a new release reports health unavailable until an aligned refresh arrives without hiding the catalog.
- [x] The current paused ClutchPacks source remains visible and rankable with delayed status disclosed.

## Verification

Run focused health-contract, authenticated-boundary, release-switch, and informational-status tests before completing this task.

## Spec Compliance

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: provider observations are independently signed, monotonic, release-bound, and sanitized. Public health is informational, exposes the next status-refresh boundary, and never changes EV availability, Top Opportunities, ordinary sorting, medians, coverage, or details.
- Divergences: none.
- Verification: contract tests passed, full Convex tests passed, signed promotion/preflight tests passed, and the ClutchPacks canary proved its known estimates remain visible and rankable while paused health remains disclosed.
