# Task: Recompute When Pack Economics Change

**ID:** buyback-adjusted-ev/006
**Depends on:** buyback-adjusted-ev/004, buyback-adjusted-ev/005
**Blocks:** buyback-adjusted-ev/008, buyback-adjusted-ev/009, buyback-adjusted-ev/012
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including invalidation, concurrency, retry, and lifecycle verification
**Status:** todo

## Start Here

Create one change matrix that maps every governing source or policy change to a new calculation fingerprint and every display-only change to an unchanged result.

## Objective

PackScout recalculates buyback-adjusted EV exactly when pack economics or evidence reliability change, converges concurrent work safely, and never publishes stale, failed, or partially recomputed results.

## Context

Prices, pools, odds, values, buyback terms, eligibility, and policies can change independently. Recalculation must be deterministic and idempotent so dynamic source updates do not create duplicate history or leave the public release with mixed economic states.

## Requirements

### Invalidation

- Recompute when public Pack Price, supported currency evidence, odds, inventory, values, payout terms, eligibility, draw semantics, essential source time, or policy version changes.
- Treat restocks, pool replacements, and supported deterministic depletion as new evidence even when product identity is unchanged.
- Recompute freshness and availability at the approved boundaries without changing immutable prior revisions.
- Ignore source changes that cannot affect the canonical input, confidence, availability, or public provenance.
- Turn newly complete evidence into an available result and newly missing or stale evidence into a deterministic unavailable result.

### Work lifecycle

- Converge concurrent work for the same product, method, and fingerprint on one immutable completed revision.
- Retry failed work idempotently without duplicating revisions or losing the last successful result.
- Prevent incomplete, stale, superseded, or failed work from becoming current or publishable.
- Bound scheduling, batch size, retry count, and duplicate event volume.
- Preserve ordering when rapid price, pull, restock, and buyback changes arrive out of order.

### Operational truth

- Measure recomputation age, queue lag, unavailable reasons, conflicts, failures, and method-version distribution with bounded labels.
- Make delayed, failed, unsupported, and conflicting evidence actionable to operators without exposing protected details publicly.
- Keep calculation events free of money values, provider payloads, credentials, user identities, and raw source fields.
- Expose the exact completed revision eligible for the next repeatable publication read.
- Retain a recovery path that reprocesses source revisions without mutating completed history.

## User-Facing Behavior

Users eventually see a coherent new result or an unavailable reason after a governing source change; they never see a partly updated value assembled from different revisions.

## Interface Contract

The recomputation boundary accepts normalized available or unavailable evidence from task 004, resolves the task 002 calculation and task 003 confidence policy, and writes through task 005's immutable revision boundary.

It returns the completed revision identity, outcome state, and bounded operational status. The publisher may read only the completed revision selected for one repeatable canonical snapshot.

## Acceptance Criteria

- [ ] Every governing input and policy change recalculates, while display-only changes leave the effective fingerprint unchanged.
- [ ] Concurrent, repeated, failed, out-of-order, and retried work converges without duplicate or incorrect current revisions.
- [ ] Restock, depletion, price, buyback, value, odds, source-time, availability, and confidence-boundary transitions behave deterministically.
- [ ] No incomplete, stale, failed, superseded, or pre-buyback result becomes eligible for publication.
- [ ] Operations can measure and recover the lifecycle without logging protected evidence or unbounded labels.
