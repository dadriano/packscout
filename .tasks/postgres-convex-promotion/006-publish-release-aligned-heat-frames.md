# Task: Publish Release-Aligned Heat Frames

**ID:** postgres-convex-promotion/006
**Depends on:** postgres-convex-promotion/004, postgres-convex-promotion/005
**Blocks:** postgres-convex-promotion/012
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including alignment and expiry verification
**Status:** done

## Architecture Continuation

This task records the completed Heat lane bound to one global catalog release. Task `postgres-convex-promotion/012` replaces only that alignment boundary so Heat proves the active manifest and its exact provider-release set; its settlement, expiry, privacy, and independent-failure guarantees remain required.

## Start Here

Calculate one one-minute Heat frame from settled observations for the active catalog release, publish it twice, and prove the second pass is unchanged and creates no duplicate signals.

## Objective

Run an independent production Heat lane that calculates one-minute aggregate frames from settled PostgreSQL observations and exposes them only when they align with the active catalog release.

## Context

Heat changes more frequently than the immutable catalog and must not force a full catalog release. The current Convex Heat model already supports compact aggregate snapshots and fail-closed reads. The production runner must replace simulated inputs with settled canonical observations while preserving independent failure and freshness behavior.

## Requirements

- Schedule Heat aggregation on one-minute frame boundaries independently from catalog promotion and provider cycles.
- Read only normalized observations at or below the settled causal watermark using the existing 15-minute current window and 24-hour baseline.
- Resolve the active canonical catalog release and calculate Heat only for public repacks in that release.
- Use the existing calculator's bounded labels, evidence counts, confidence behavior, and deterministic ordering; do not reinterpret Heat as EV, profitability, certainty, or recommendation.
- Publish only compact aggregate frame metadata and per-repack signals to Convex; never publish raw observations.
- Identify the catalog release and settled watermark used by every frame.
- Stage/reconcile each Heat frame in bounded idempotent operations before activating it.
- Expose a frame only when its catalog release matches the active catalog release. Misaligned data returns the existing unavailable state.
- Keep catalog and Heat activation independent. Heat failure does not block catalog; catalog failure leaves the previous aligned Heat readable until expiry.
- Preserve the 15-minute fail-closed expiry even if no new frame arrives, and reject attempts to reactivate expired or regressed frames.
- Record a durable PostgreSQL Heat publication attempt/receipt so lost acknowledgements and restarts reconcile exactly.
- Skip immutable signal rewrites for unchanged frames while maintaining honest generation/expiry metadata.

## User-Facing Behavior

The existing Heat surfaces update about once per minute when settled observations are available. If Heat is stale, expired, or for another catalog release, users see the existing unavailable behavior while catalog browsing remains available.

## Interface Contract

The Heat runner accepts the active catalog release receipt, settled watermark, normalized observation repository, existing calculator, and an authenticated Convex Heat transport. It emits a bounded frame containing catalog release ID, source watermark, frame time, generated/expiry times, content hash, counts, and existing per-repack aggregate signals.

Convex activation validates catalog alignment and monotonic frame identity. PostgreSQL retains exact operation and terminal receipt identity for reconciliation.

## Acceptance Criteria

- [x] A healthy minute publishes one aggregate frame built only from settled normalized observations and public repacks in the active catalog release.
- [x] Exact frame replay is idempotent; conflicting or regressed frame content fails closed.
- [x] Raw observation or protected source fields cannot enter Convex Heat documents.
- [x] A frame aligned to a non-active catalog release is unavailable and cannot replace the aligned active frame.
- [x] Heat transport/calculation failure does not block catalog activation or alter catalog data.
- [x] Catalog publication failure preserves the prior aligned Heat until its normal expiry.
- [x] Heat becomes unavailable after 15 minutes without a valid aligned refresh, including when the worker is down.
- [x] Lost acknowledgements and worker restart reconcile to one terminal PostgreSQL attempt and one active frame.

## Verification

`npm run test:services && npm run test:database && npm run test:worker && npm run test:convex`

## Build Evidence

- The protocol-maximum fixture publishes 8,000 repacks as 252 bounded operations in one runner cycle; the integrated local run completed in about 10 seconds. This is deterministic local evidence, not a hosted p95 measurement.
- PostgreSQL proof tests bind the active catalog receipt, every canonical catalog batch, the Heat predecessor, and exact terminal receipt bytes before activation or recovery.
- Convex tests cover atomic activation, catalog alignment, unchanged signal-set reuse, 15-minute scheduled expiry, status reconciliation, retention, and stale/conflicting frames.
- `npm run verify:framework` passed on the integrated branch.
