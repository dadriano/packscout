# Task: Promote Providers and Reconcile Manifests

**ID:** postgres-convex-promotion/011
**Depends on:** postgres-convex-promotion/007, postgres-convex-promotion/008, postgres-convex-promotion/009, postgres-convex-promotion/010
**Blocks:** postgres-convex-promotion/012, postgres-convex-promotion/014
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including crash, concurrency, and bootstrap proof
**Status:** not started

## Start Here

Run platform A and B publication lanes concurrently, lose A's finalize response, delay B, then prove A reaches a completed head and one serialized manifest attempt activates A's new release with B's prior active release exactly once.

## Objective

Operate catalog promotion as two durable phases: independent provider release completion followed by one serialized, compare-and-swap manifest activation with exact PostgreSQL-to-Convex reconciliation.

## Context

The completed catalog runner has one organization-global lane and one release attempt. The new model needs concurrent provider lanes so one platform does not block another, but public activation must remain serialized. PostgreSQL stays canonical for scheduling, attempt state, exact request bytes, receipts, and recovery. Convex stores the immutable public artifacts and authoritative active-manifest pointer.

## Requirements

### Durable provider phase

- Maintain one provider promotion lane per approved organization, deployment, and stable `platformKey`; coalesce only that platform's provider checkpoint and allow different platforms to claim work concurrently.
- Persist the selected provider plan, exact canonical request bytes, operation order, dispatch progress, claim token, retry state, and exact signed receipt before acknowledging completion.
- Reconcile ambiguous start, batch, or finalize outcomes through status before resending terminal work; reject stale claims and lower checkpoints.
- Record `published`, `reused`, or terminal failure independently per platform and advance the PostgreSQL completed head only from a verified Convex completion receipt.
- Never publish canonical rows directly from ingestion workers and never add per-row dual writes to Convex.

### Serialized manifest phase

- Enqueue manifest evaluation after provider completion, reuse, lifecycle/configuration settlement, or successful observation; coalesce evaluations behind one organization/deployment manifest lane.
- Permit only one active manifest attempt and bind it to the expected active manifest, shared configuration epoch, enabled-platform snapshot, chosen provider completed heads, and active fallbacks.
- Apply the initial-all-ready rule, the new-epoch all-provider barrier, delayed-provider active-release reuse, newly enabled provider readiness, and disable-only-through-manifest behavior before dispatch.
- Persist and reconcile exact manifest request bytes and terminal receipts, treating a compare-and-swap loss as a fresh evaluation rather than an unsafe replay.
- Track the latest completed provider head separately from each active provider head derived from the confirmed active manifest.

### Bootstrap and operations

- Bootstrap only from a proven empty Convex deployment or an exact active-manifest proof that includes every referenced provider release, matching content/config hashes, active-state receipt, and corresponding PostgreSQL terminal receipts.
- Fail startup on partial, mixed-epoch, receipt-mismatched, caller-selected, or compatibility-path state; do not infer authority from Convex rows alone.
- Expose safe health for each provider's settled/completed/active checkpoints and lag, plus manifest epoch, attempt age, delayed count, retry state, last activation, and reconciliation failure.
- Target provider-checkpoint-to-manifest activation p95 under one minute in healthy conditions without requiring unrelated delayed providers to republish.
- Keep orchestration provider-neutral: adding a configured platform registers another lane without a provider-identifier branch in generic promotion code.

## User-Facing Behavior

An unaffected provider's settled catalog can become public while another provider is delayed. Users still see one atomic catalog release, with the delayed provider's prior values and the existing delayed freshness state rather than a partial or mixed catalog.

## Interface Contract

`ProviderPromotionLane` is keyed by server-bound organization/deployment/platform and exposes coalesce, claim, heartbeat, prepared-operation persistence, exact acknowledgement, retry, terminal acknowledgement, completed-head proof, and health.

`ManifestPromotionLane` is keyed once per organization/deployment and exposes coalesced evaluation, serialized claim, selected provider-reference proof, compare-and-swap acknowledgement, active-head reconciliation, retry, and health.

`CatalogPromotionBootstrapProof` binds the active manifest receipt, canonical manifest request, ordered provider references, every provider completion receipt, configuration epoch, and PostgreSQL lane heads. Internal type names do not define this contract; no weaker or inferred proof satisfies startup.

## Acceptance Criteria

### Phase behavior

- [ ] Platforms A and B can assemble and complete concurrently without sharing a claim or blocking one another's completed head.
- [ ] Provider completion never changes public state; one serialized manifest compare-and-swap is the only activation step.
- [ ] A delayed provider with an active same-epoch release is reused, while a first-time or newly enabled provider without an eligible release blocks activation.
- [ ] A new configuration epoch cannot activate until all enabled providers have complete releases in that epoch.
- [ ] A settled disable remains invisible until a new manifest omits that provider and activates.

### Recovery and proof

- [ ] Restart, stale claim, exact replay, lost response, retryable transport failure, deterministic rejection, and compare-and-swap loss reach one reconcilable outcome without duplicate artifacts.
- [ ] Bootstrap accepts proven empty or exact matching active state and rejects partial, mismatched, mixed-epoch, or receipt-incomplete state.
- [ ] Health reports separate settled, completed, and active provider heads plus manifest lag without secrets, tenant selectors, or protected source detail.
- [ ] Healthy representative-volume tests meet the one-minute provider-to-manifest target while a delayed unrelated provider remains on its active release.
- [ ] No provider-specific generic branch, per-row Convex write, dual publication path, or compatibility shim exists.

## Verification

`npm run test:database && npm run test:services && npm run test:worker && npm run test:convex`
