# Task: Establish Split Durable Promotion Job Records

**ID:** convex-promotion-jobs/001
**Depends on:** distributed-canonical-warehouse/013, distributed-canonical-warehouse/014, distributed-canonical-warehouse/015
**Blocks:** convex-promotion-jobs/003, convex-promotion-jobs/004, convex-promotion-jobs/006, convex-promotion-jobs/007
**Status:** complete
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Persist replay-safe job admission and bounded operator evidence in the authority
that owns the work: provider-publication records in each provider database and
manifest-reconciliation records in the central database.

## Requirements

### Provider-local records

- Add singleton wake and schedule state, invocation summaries/details, scoped
  delivery identities, and delivery tombstones to the provider schema.
- The database identity supplies provider scope; rows do not store or accept a
  caller-selected provider key, database target, credential, or organization.
- Wake requested/acknowledged generations are monotonic. A generation-N
  completion cannot acknowledge generation N+1.
- Reuse the provider promotion worker lease and Task 014 release/operation/
  receipt truth instead of duplicating publication ownership.

### Central records

- Add central manifest wake/schedule/invocation/tombstone records and one
  per-provider manifest-gate intent with requested and acknowledged generation.
- Central rows may FK only to the central provider registry. Provider-local
  invocation, attempt, release, and receipt IDs remain opaque evidence.
- Provider invocation history reaches central monitoring only through an
  idempotent sanitized projection; that projection never admits provider work.

### Admission, outcomes, and retention

- Record trigger `change_wake | reconciliation_cron | manual | continuation`.
- Record terminal outcome `caught_up | no_change | coalesced |
  continuation_required | deferred | blocked | failed`.
- Validate expiry and trusted scope, then resolve a same-key retained invocation
  or tombstone before current generation/window freshness.
- Retain summaries and compact detail for 30 days, cap at 50,000 per logical job,
  and retain delivery tombstones for the full replay window.
- Pruning never removes active work, current wake/schedule health, completed
  publication proof, manifest activation proof, or relay state.

## Acceptance Criteria

- [x] Independent provider databases cannot read, modify, or collide with one
  another's job rows or delivery keys.
- [x] Provider and central authorities can use the same opaque delivery token
  without collision because their scoped digests differ.
- [x] Same-key retry returns the original invocation; a pruned live key returns
  `existing_pruned`; an expired key performs no job action.
- [x] A newer wake remains pending when an older invocation closes.
- [x] No-change and coalesced scheduled runs retain check-in and terminal
  evidence without manufacturing a publication attempt.
- [x] Retention converges under age and cap without deleting protected truth.
- [x] Schemas contain no `platform_*` tables, fixed roster, cross-database FK,
  legacy composite-client dependency, or manifest `clear`.

## Verification

Run provider and central Prisma validation/migration invariants, focused
repository tests for replay/generation/retention in both authorities, database
typecheck/lint, and `npm run test:prisma-schema`.

## Spec Compliance

Implementation must satisfy `tech-001-distributed-promotion-jobs.md`. The
verified legacy ledger is a port source, not completion evidence.
