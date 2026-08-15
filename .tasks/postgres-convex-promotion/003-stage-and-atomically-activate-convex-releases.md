# Task: Stage and Atomically Activate Convex Releases

**ID:** postgres-convex-promotion/003
**Depends on:** none
**Blocks:** postgres-convex-promotion/004, postgres-convex-promotion/006
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including authenticated replay and retention tests
**Status:** in_progress

## Start Here

Drive one authenticated publication through start, two replay-safe batches, reconciliation, and finalize while continuously asserting that public queries resolve only the previous active release until finalize commits.

## Objective

Provide a production Convex publication protocol that accepts bounded authenticated writes, proves the staged release exactly matches its manifest, and changes public visibility atomically.

## Context

Convex mutations are transactional, but a full catalog can exceed one mutation's safe limits. The existing development seed is intentionally one-shot and guarded. Production needs a resumable protocol whose operations are independently idempotent and whose final pointer update cannot expose partial or conflicting content.

## Requirements

- Expose server-only authenticated publication operations for start, batch apply, finalize, status/reconcile, unchanged observation refresh, rollback, and bounded retention.
- Authenticate every request with a versioned key identifier, signed method/path/body digest, request timestamp, nonce, and constant-time signature verification.
- Reject missing/unknown keys, invalid signatures, expired timestamps, replayed nonces, oversized bodies, unsupported schema versions, and malformed public data with stable structured errors.
- Keep authentication secrets only in Convex environment variables and worker/server configuration; never store or return them in public documents.
- Start a staging release with expected immutable manifest identity, counts, hashes, source watermark, and batch count without inventing completion time.
- Apply bounded batches idempotently by operation/publication/batch identity. Exact replay returns the stored receipt; conflicting replay fails without changing staged data.
- Enforce deterministic dependency order and reject invalid references, unapproved origins/actions, blocked manifest fingerprints, and protected fields.
- Reconcile exact staged counts and hashes before finalize; finalize rechecks the manifest block and expected active predecessor.
- Atomically mark the release complete, move active/previous pointers, and store the terminal receipt in one mutation.
- An unchanged refresh advances observation/freshness metadata under a monotonic stale guard without rewriting immutable release entities or moving pointers.
- Status returns signed/reconcilable terminal receipts so PostgreSQL can recover a lost response without replay ambiguity.
- Rollback never makes a known unsafe outgoing fingerprint the previous release; a safe complete target activates or an explicitly authorized clear makes the catalog unavailable.
- Retain active and previous releases unconditionally, at most three other complete releases for seven days, and staging/failed releases for 24 hours. Delete at most 100 owned documents per mutation and never delete a pointer target.
- Keep existing public query shapes and fail-closed active-release resolution unchanged.

## User-Facing Behavior

Public readers switch from one complete release to another in a single logical transition. Failed, incomplete, replayed, blocked, or conflicting publications do not become visible.

## Interface Contract

The production publisher uses stable request/receipt envelopes for:

- `start`: expected predecessor, immutable manifest identity, source watermark, batch/count/hash expectations;
- `applyBatch`: publication ID, ordered batch number, batch hash, bounded validated entities;
- `finalize`: expected counts/hashes and predecessor guard;
- `refreshObservation`: active content identity plus monotonic observation metadata;
- `status`: operation/publication identity and signed terminal state;
- `rollback` and `retain`: protected operational commands with exact terminal receipts.

Every receipt includes operation identity, publication identity where relevant, terminal/result state, server time, and enough digest material for exact PostgreSQL reconciliation.

## Acceptance Criteria

- [ ] Public queries continue returning the prior complete release throughout staging and batch application.
- [ ] Exact start/batch/finalize replay is idempotent; conflicting replay returns a stable error and changes no data.
- [ ] Invalid authentication, stale requests, reused nonces, invalid schema, protected data, blocked fingerprints, and hash/count mismatches fail closed.
- [ ] Finalize exposes the new release only when every expected count, hash, reference, and predecessor guard reconciles.
- [ ] An unchanged observation refresh changes freshness only and rejects stale metadata.
- [ ] A lost response can be reconciled through an authenticated status receipt.
- [ ] Rollback/clear and bounded retention preserve pointer safety and delete no active or previous data.
- [ ] Existing public catalog tests pass without public DTO or query-shape changes.

## Verification

`npm run test:convex && npm run typecheck:convex`
