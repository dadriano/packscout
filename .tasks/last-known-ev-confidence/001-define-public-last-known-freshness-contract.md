# Task: Define the Public Last-Known Freshness Contract

**ID:** last-known-ev-confidence/001
**Depends on:** none
**Blocks:** last-known-ev-confidence/002, last-known-ev-confidence/003, last-known-ev-confidence/004
**Estimated scope:** medium
**Estimated effort:** 1 day for one builder, including strict contract and boundary tests
**Status:** done

## Start Here

Use the PR #50 merge amendment in `_index.md`: known dynamic estimates use one last-known projection; confidence is 7,500 at 60 minutes with no static penalties, then declines linearly to zero by four hours without removing economics.

## Objective

Every service and public surface shares one versioned, deterministic contract for current, last-known, historical, and unavailable EV without changing the immutable V1 calculation record.

## Context

The V1 confidence policy combines calculation-time evidence limitations with a hard public expiry. Existing releases and database rows identify that policy exactly. This task adds a public presentation policy rather than relabeling old V1 records.

## Requirements

- Keep immutable raw calculation states separate from the single versioned last-known display projection and explicit unavailable state.
- Preserve the four EV metrics whenever the underlying V1 result was calculable, including a confidence score of zero.
- Encode the approved linear age penalty with bounded integer arithmetic; preserve sold-out economics while continuing confidence aging.
- Preserve the exact V1 age-band scores through 60 minutes by evaluating them at the pinned response clock, and distinguish over-60 source age from the 30-through-60 limitation.
- Keep missing essential evidence and the existing positive-EV suppression path unavailable.

## User-Facing Behavior

No screen changes in this task. Its contract guarantees that later surfaces receive one state, score, evaluation timestamp, source timestamp, limitations list, and informational provider-health explanation.

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

Historical implementation results below precede the PR #50 merge amendment; its original half-up formula is superseded by the retained-EV contract described above.

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: added a separately versioned read-time presentation contract, exact boundary examples, deterministic half-up decay, immutable raw V1 preservation, provider-health schemas, and strict dynamic response clocks exactly as specified.
- Divergences: none.
- Verification: `npm test --workspace @packscout/contracts` (317/317), contracts typecheck and lint, `git diff --check`, and `npm run scan:framework-standards:ratchet` all passed.
