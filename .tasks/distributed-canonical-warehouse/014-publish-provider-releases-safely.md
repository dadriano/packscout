# Task: Publish Provider Releases Safely

**ID:** distributed-canonical-warehouse/014
**Depends on:** distributed-canonical-warehouse/013
**Blocks:** distributed-canonical-warehouse/015, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including authenticated operations, idempotent receipts, and lost-response recovery
**Status:** in progress

## Start Here

Write the operation transcript for starting, batching, finalizing, and reconciling one provider release, including a duplicate request and a lost final response with the exact receipt expected afterward.

## Objective

Transfer immutable provider releases into Convex with authenticated, idempotent, receipt-confirmed operations while keeping completion separate from public activation.

## Context

The provider database remains authoritative for promotion work and confirmed checkpoints. Convex stores immutable frontend-serving artifacts. Network calls cannot share the provider transaction, so the publisher records exact operations, digests, and receipts and advances its checkpoint only after it can prove Convex accepted the intended bytes.

Each provider publishes independently. Completing a provider release advances that provider's completed head but never changes the active manifest. Another task performs the only public activation step.

## Requirements

### Authenticated operations

- Expose server-only start, bounded batch, finalize, status, block, and unchanged-release reuse operations for one provider release.
- Authenticate and authorize every operation for the exact environment, provider, release, predecessor, catalog version, schema version, and operation kind.
- Reject browser calls, cross-provider release IDs, expired authorization, wrong predecessor, incompatible schema, changed request body, and oversized batches.
- Keep signing keys, credentials, provider connection data, internal checkpoints, and protected source evidence outside Convex documents and responses.
- Return stable bounded errors and receipts without raw internal failure bodies.

### Idempotency and receipts

- Bind every operation to one idempotency key, exact request digest, body hash, batch index, expected counts, and provider release ID.
- Repeating identical bytes returns the prior receipt; reusing an idempotency key with changed bytes fails as a conflict.
- Store provider-local operation intent before the network call and terminalize it from the exact Convex receipt.
- Reconcile timeout, duplicate delivery, lost acknowledgement, restart, and ambiguous response through status lookup before retrying a mutation.
- Advance the provider confirmed publication checkpoint only after every required release receipt and final count/hash verification is durable.

### Completion behavior

- Finalize only after every expected bounded batch exists once, all hashes and counts match, and every reference stays inside the release's provider and catalog boundary.
- Mark the provider release immutable and advance a monotonic completed-provider head after finalization.
- Keep completed and active provider heads separate; completion never edits the active manifest.
- Block a failed or invalid release without changing the prior completed or active release.
- Reuse a complete unchanged release without duplicating batches or advancing a false content version.

### Provider independence

- Give every provider independent operation state, lease fence, retry schedule, completed head, confirmed checkpoint, and safe diagnostics.
- Let a healthy provider publish while another provider database, release, or network path is failed.
- Apply bounded retries and backpressure per provider so one backlog cannot exhaust the publisher fleet.
- Record operation latency, retry, ambiguity, completion, block, checkpoint lag, and receipt reconciliation metrics by provider.
- Preserve unconsumed provider promotion changes until every required provider-local consumer checkpoint passes them.

## User-Facing Behavior

Users do not see a release merely because it finished uploading. If publication fails or a receipt is lost, the currently active provider version remains unchanged while the worker reconciles safely. Other providers continue publishing independently.

## Interface Contract

Each publication operation identifies provider, provider release, catalog version, schema version, predecessor, operation kind, idempotency key, request digest, batch index, body hash, and expected counts. Each receipt identifies the accepted operation and resulting immutable lifecycle.

The output is a complete provider release and completed-provider head eligible for manifest selection. It does not change the active provider gate.

## Acceptance Criteria

### Operation acceptance

- [ ] Start, batch, finalize, status, block, and reuse operations enforce server-only authentication, provider ownership, schema, predecessor, and bounds.
- [ ] Identical retries return the prior receipt, while changed bytes under one idempotency key fail without mutation.
- [ ] Timeout, duplicate delivery, lost acknowledgement, and restart reconcile exact status before checkpoint movement.
- [ ] Finalization verifies every batch, count, hash, and reference before marking the release complete.
- [ ] Protected provider and infrastructure data never appears in Convex artifacts, operation responses, logs, or diagnostics.

### Independence acceptance

- [ ] Completing a provider release advances only its completed head and never changes the active manifest.
- [ ] A failed release preserves the prior complete and active release.
- [ ] One failed provider cannot block another provider's publication or exhaust its retry capacity.
- [ ] Confirmed checkpoint advancement occurs only after durable exact receipts.
- [ ] Publication metrics expose provider-specific lag, retries, ambiguity, completion, and failure without secrets.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Exact canonical request bytes and append-only receipts gate lifecycle and checkpoint advancement.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
