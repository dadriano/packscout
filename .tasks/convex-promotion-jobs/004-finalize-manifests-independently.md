# Task: Reconcile One Provider Manifest Gate Centrally

**ID:** convex-promotion-jobs/004
**Depends on:** convex-promotion-jobs/001, convex-promotion-jobs/002, distributed-canonical-warehouse/015
**Blocks:** convex-promotion-jobs/005
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Run one central bounded manifest coordinator that fairly applies independent
provider-gate changes while serializing Convex compare-and-swap activation.

## Requirements

- Claim one bounded pending provider gate from central durable intent using fair
  ordering and per-provider retry evidence.
- Validate the trusted roster row and exact complete provider release/catalog
  proof through the provider gateway or verified relay evidence.
- Apply exactly one `advance | add | remove | rollback` operation.
- Preserve every unrelated manifest entry byte-for-byte; do not require a common
  configuration epoch or all-provider readiness.
- Persist exact request/status/receipt evidence centrally before acknowledging
  the provider gate generation.
- Reconcile duplicate delivery, timeout, lost acknowledgement, restart, stale
  CAS, and key rotation from exact signed status.
- One unavailable or invalid provider stays pending/deferred and cannot block a
  healthy provider gate.
- Drain at most 50 seconds and 25 attempts, creating durable continuation when
  more central gate work remains.
- The coordinator never holds provider publication credentials, mutates
  provider-local publication truth, or uses manifest `clear`.

## Acceptance Criteria

- [x] With providers A and B active, advancing A changes only A and immutable
  manifest metadata; B's entry is byte-for-byte identical.
- [x] Add, remove, and rollback affect only the selected provider and require
  explicit authorized central intent.
- [x] Provider disablement alone does not remove its active entry.
- [x] Missing/incomplete/cross-provider/mismatched proof performs no Convex
  mutation and preserves the prior active manifest.
- [x] CAS loss returns/persists the current active state and safely retries or
  defers without overwriting it.
- [x] A failed or unreachable provider does not block another provider's
  activation.
- [x] Duplicate/status/restart recovery yields one accepted manifest transition.
- [x] No common-epoch barrier, fixed roster, provider credential, cross-database
  transaction, or clear operation exists.

## Verification

Run distributed Task 015 repository/service/Convex tests, A/B unrelated-entry
preservation and stale-CAS integration tests, central job unit/composition
tests, key-rotation/target-drift tests, and central/worker/service
typecheck/lint.

## Spec Compliance

The prior manifest-finalizer implementation is a bounded-run and recovery port
source only; its global barrier and clear path are forbidden.

Independent gate/coordinator, add/advance/remove/rollback, unrelated-entry
preservation, compare-and-swap recovery, and failed-provider isolation checks
pass against the current manifest contracts.
