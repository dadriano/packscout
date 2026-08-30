# Task: Reconcile and Retain Publication State

**ID:** distributed-canonical-warehouse/017
**Depends on:** distributed-canonical-warehouse/012, distributed-canonical-warehouse/014, distributed-canonical-warehouse/015
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including startup recovery, retention barriers, and destructive-safety tests
**Status:** not started

## Start Here

Write the expected recovery result for four states: proven-empty Convex, an in-flight provider release, a lost catalog receipt, and an active manifest with previous rollback artifacts.

## Objective

Recover publication safely after restarts or ambiguous network outcomes and retain every artifact required by active, previous, in-flight, or authorized rollback state.

## Context

Provider databases, central `packscout`, and Convex cannot commit together. Exactly-once effect comes from durable operation intents, immutable content, idempotency keys, exact receipts, monotonic consumer checkpoints, lease fences, and startup reconciliation.

The system is pre-launch, so bootstrap begins from a proven-empty new environment or the exact state produced by these tasks. This task does not interpret, migrate, reset, or delete legacy production data. Saved user items are durable Convex records and remain outside catalog artifact cleanup.

## Requirements

### Startup reconciliation

- Prove an environment empty before first bootstrap or load the exact central, provider-local, catalog, release, receipt, checkpoint, and manifest state already created by this feature.
- Reconcile nonterminal provider and catalog publication operations against Convex status before retrying or failing them.
- Reconcile completed provider heads, catalog versions, active manifest entries, local confirmed checkpoints, and exact receipts without guessing from timestamps.
- Reject provider identity, schema, digest, receipt, predecessor, catalog, and manifest mismatches and leave active public state unchanged.
- Recover each provider independently so an unreachable provider does not block reconciliation for another provider.

### Retention barriers

- Protect active and previous manifests, every selected provider release and catalog version, in-flight operations, blocked evidence, and authorized rollback artifacts.
- Protect provider promotion changes until correlation and provider-release consumers each pass their own confirmed checkpoints.
- Protect central catalog changes until catalog-version publication and manifest references no longer require them.
- Keep exact operation digests and receipts long enough to reconcile every protected operation and checkpoint.
- Keep saved repacks and collectibles outside artifact cleanup and local reset tools.

### Bounded cleanup

- Clean only artifacts proven unreachable from active, previous, in-flight, blocked, rollback, saved-item, and checkpoint roots.
- Use bounded batches, resumable progress, idempotent deletion, lease fencing, and explicit environment scope.
- Refuse destructive cleanup when ownership, active manifest, protected roots, or schema compatibility cannot be proven.
- Record safe counts, cutoffs, receipts, failures, and actor or worker identity without storing deleted protected content.
- Apply per-provider backpressure so one large backlog cannot block another provider's reconciliation or cleanup.

### Fault recovery

- Recover from central outage, one provider outage, Convex outage, timeout, duplicate request, lost acknowledgement, stale lease, and process restart at every publication boundary.
- Never advance a consumer checkpoint from an uncertain request without the exact accepted receipt.
- Never roll back a provider-local canonical transaction because central or Convex publication is unavailable.
- Preserve the prior active manifest until a new activation receipt is proven.
- Emit bounded metrics for nonterminal age, receipt ambiguity, checkpoint lag, protected artifact count, cleanup progress, and provider-specific failure.

## User-Facing Behavior

Catalog reads remain on the prior active manifest during recovery. A restart or lost response does not expose partial data, duplicate a release, erase saves, or force healthy providers to wait for an unreachable provider. Cleanup never removes data needed for current reads or authorized rollback.

## Interface Contract

A reconciliation result is scoped to one environment and authority and reports `reconciled`, `still_in_flight`, `blocked`, or `unavailable`, plus safe counts, exact checkpoint positions, receipt identity, and retry time. It does not infer success from elapsed time.

A retention run receives explicit protected roots and cutoffs and returns deleted, retained, blocked, and failed counts. Missing proof produces no destructive action.

## Acceptance Criteria

### Reconciliation acceptance

- [ ] Proven-empty bootstrap, in-flight release, lost catalog receipt, and active-manifest restart recover to exact expected state.
- [ ] No ambiguous operation advances a checkpoint without an exact Convex receipt.
- [ ] One unreachable provider does not block catalog or healthy-provider reconciliation.
- [ ] Identity, schema, digest, predecessor, catalog, and manifest mismatches fail closed while preserving active public data.
- [ ] Central or Convex outage never rolls back an already committed provider page.

### Retention acceptance

- [ ] Active, previous, in-flight, blocked, rollback, saved-item, and checkpoint-required artifacts survive cleanup.
- [ ] Cleanup is bounded, resumable, idempotent, environment-scoped, and fenced against concurrent owners.
- [ ] Missing ownership or protected-root proof produces zero destructive changes.
- [ ] Promotion and catalog changes remain until every independent required consumer checkpoint passes them.
- [ ] Recovery and cleanup metrics identify lag and failure per provider without protected data.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Cleanup requires complete protected-root proof and leaves durable saved items outside artifact lifecycle.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
