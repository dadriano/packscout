# Task: Expose Trustworthy Pack Availability

**ID:** dataforest-source-integration/009
**Depends on:** dataforest-source-integration/005
**Blocks:** dataforest-source-integration/010
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including public contracts, query behavior, presentation, accessibility, and focused verification
**Status:** done

## Start Here

Project four deterministic packs representing available, unavailable, unknown, and explicitly sold out into the public pack contract, then prove DataForrest `available = false` reaches only unavailable.

## Objective

Keep packs discoverable while accurately separating confirmed availability, confirmed unavailability, unknown availability, and authoritative sold-out state.

## Context

DataForrest supplies `available` as true, false, or null. False includes removal and disappearance cases and does not prove why a pack is unavailable. PackScout may show Sold out only when another authoritative canonical fact explicitly supplies that meaning.

The repository has public release contracts, validators, queries, and UI fixtures, but its production canonical-to-public publisher and finalizer are not implemented. This task makes the public contract and UI ready for the four availability states without claiming that live DataForrest records can already reach public storage.

## Requirements

### Public contract

- Expose exactly `available`, `unavailable`, `unknown`, and `sold_out` as public pack availability states.
- Project canonical `available`, `unavailable`, `unknown`, or `sold_out` unchanged and reject a missing, inconsistent, or unsupported canonical availability state; task 005 alone owns DataForrest true, false, and null mapping.
- Accept sold out only from explicit authoritative canonical provenance and never infer it from canonical unavailable or unknown state, missing evidence, disappearance, price, or nested status.
- Include sanitized stable provider identity and catalog observation time required by the existing public trust model.
- Exclude source-instance IDs, connection IDs, credentials, cursors, vendor cursors, processor diagnostics, quarantine, raw market events, payment methods, and protected provider data.

### Catalog and action behavior

- Keep unavailable, unknown, and sold-out packs discoverable in the complete catalog with distinct text labels.
- Include only available packs in current-opportunity rankings, positive-EV summaries, and purchase-oriented selections.
- Remove purchase actions for unavailable, unknown, and sold-out packs while preserving safe historical detail.
- Restore ranking and purchase behavior when a later catalog revision returns an unavailable or unknown pack to available.
- Preserve valid filters and selection across availability updates, using deterministic fallback when the selected pack leaves the current result.

### Presentation and states

- Label the states as Available, Unavailable, Availability unknown, and Sold out without relying on color.
- Explain that Unavailable means the platform does not currently present the pack as available and does not assert a sold-out reason.
- Keep unavailable and unknown distinct from loading, missing initial data, stale provider data, and query failure.
- Preserve keyboard, screen-reader, narrow-screen, theme, reduced-motion, and 200-percent-zoom usability.
- Reuse established public catalog and pack-detail patterns instead of adding a parallel availability experience.

### Publication handoff

- Define the versioned canonical availability input and public projection output that the separate production publisher must consume.
- Reject inconsistent canonical availability rather than repairing it at the public boundary.
- Keep public consumers source-agnostic; they receive stable provider and availability facts, not DataForrest identifiers.
- Prove projection, validation, query, and UI behavior with deterministic canonical fixtures and current public release contracts.
- Record live DataForrest-to-public propagation as blocked on the separate production publisher and finalizer; this task adds no substitute publisher, activation, or eligibility state.

## User-Facing Behavior

A buyer can still find a pack that disappeared from a provider. It says Unavailable, has no purchase action, and is not described as sold out. A pack with no current availability evidence says Availability unknown. A separately authoritative sold-out pack retains its distinct Sold out label.

## Interface Contract

The public pack projection preserves the existing `availability` field and expands its exact values to `available`, `unavailable`, `unknown`, and `sold_out`. Public queries consume the value directly and never infer it from missing data, nested provider wording, price, stock, or action availability.

## Acceptance Criteria

### Contract proof

- [x] End-to-end task-005 fixtures prove true, false, null, disappearance, and reappearance reach the correct canonical states, while the public projection consumes those states unchanged and false never becomes sold out.
- [x] The full catalog retains all four states while rankings and purchase actions include only available packs.
- [x] Public contracts reject protected ingestion data and inconsistent availability provenance.

### Experience and handoff proof

- [x] Deterministic canonical fixtures prove public contract and UI readiness without claiming live ingestion reaches public storage.
- [x] The completion evidence names the separate production publisher and finalizer as the remaining live-publication prerequisite, with no substitute certification or eligibility state.
- [x] Contract, query, component, accessibility, and browser coverage proves all labels, actions, transitions, empty states, and required widths.

## Verification

- `npm run test:contracts` — 164 contract tests passed for the four-state public contract and protected-field rejection.
- `npm run test:services` — the full services suite passed, including the canonical mapper-to-public handoff and production release projector provenance guard.
- `npm run test:convex` — 20 files and 127 tests passed, including available-only defaults, the all-state catalog, selection retention, deterministic fallback, disappearance, and reappearance.
- `npm run test:frontend` — 181 frontend tests passed; focused typecheck, lint, and production build checks also passed.
- A clean loopback Convex seed and in-app browser pass at `/packs?availability=all` showed one or more rows in each of Available, Unavailable, Availability unknown, and Sold out. Nonavailable rows exposed no promo or purchase action; the default `/packs` view hid them; a selected unavailable pack survived a reload through the `selected` query parameter; the 390-by-844 viewport remained usable; and the browser console contained no errors.

## Spec Compliance

- The production public projector now invokes the versioned source-neutral availability handoff and rejects bare or contradictory `sold_out` provenance instead of trusting an enum alone.
- DataForrest boolean/null behavior remains upstream in task 005; the public boundary only preserves validated canonical state.
- Catalog history remains discoverable in the all-state view, while rankings, dashboard opportunity sets, promos, and purchase links remain available-only.
- The separate production canonical-to-Convex publisher and finalizer remain unimplemented prerequisites for live DataForrest propagation. This task added no substitute publisher, eligibility state, certification ledger, or DataForrest-specific public branch.
