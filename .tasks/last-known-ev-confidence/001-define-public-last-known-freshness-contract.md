# Task: Define the Public Last-Known Freshness Contract

**ID:** last-known-ev-confidence/001
**Depends on:** none
**Blocks:** last-known-ev-confidence/002, last-known-ev-confidence/003, last-known-ev-confidence/004
**Estimated scope:** medium
**Estimated effort:** 1 day for one builder, including strict contract and boundary tests
**Status:** done

## Start Here

Write the 60-minute boundary table first: 60 minutes stays `current` at 7,500 with no static penalties; 60 minutes plus one millisecond becomes `last_known`, keeps all EV metrics, and begins the rational decay.

## Objective

Every service and public surface shares one versioned, deterministic contract for current, last-known, historical, and unavailable EV without changing the immutable V1 calculation record.

## Context

The V1 confidence policy combines calculation-time evidence limitations with a hard public expiry. Existing releases and database rows identify that policy exactly. This task adds a public presentation policy rather than relabeling old V1 records.

## Requirements

- Define a versioned public freshness policy with `current`, `last_known`, `historical`, and `unavailable` states.
- Preserve the four EV metrics whenever the underlying V1 result was calculable, including a confidence score of zero.
- Encode the approved rational decay with integer arithmetic and half-up rounding.
- Preserve the exact V1 age-band scores through 60 minutes by evaluating them at the pinned response clock, and distinguish over-60 source age from the 30-through-60 limitation.
- Keep missing essential evidence and the existing positive-EV suppression path unavailable.

## User-Facing Behavior

No screen changes in this task. Its contract guarantees that later surfaces receive one state, score, evaluation timestamp, source timestamp, limitations list, and ranking-eligibility explanation.

## Interface Contract

An available public estimate includes immutable economics and calculation metadata plus:

- public freshness-policy version;
- presentation state;
- confidence evaluated at one explicit timestamp;
- derived confidence score and band;
- bounded presentation limitations.

An unavailable estimate contains null economics and one stable public reason. It cannot be produced from age alone.

## Acceptance Criteria

- [x] Exact examples at 15m, 30m, 60m, 60m+1ms, 2h, 25h, 49h, and 7d pass in contract tests.
- [x] The score is deterministic, monotonic, nonnegative, and a rounded zero retains EV.
- [x] V1 calculation-policy fields remain unchanged and cannot be mislabeled as the public freshness policy.
- [x] Unknown source time, missing economics, positive suppression, and sold-out state remain distinct.
- [x] Unknown fields, invalid clocks, impossible state combinations, and unsafe arithmetic are rejected.

## Verification

Run the focused contract test suite and typecheck before completing this task.

## Spec Compliance

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: added a separately versioned read-time presentation contract, exact boundary examples, deterministic half-up decay, immutable raw V1 preservation, provider-health schemas, and strict dynamic response clocks exactly as specified.
- Divergences: none.
- Verification: `npm test --workspace @packscout/contracts` (317/317), contracts typecheck and lint, `git diff --check`, and `npm run scan:framework-standards:ratchet` all passed.
