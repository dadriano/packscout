# Task: Run and Reconcile Catalog Promotions

**ID:** postgres-convex-promotion/004
**Depends on:** postgres-convex-promotion/002, postgres-convex-promotion/003
**Blocks:** postgres-convex-promotion/006, postgres-convex-promotion/007
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including retry and lost-acknowledgement verification
**Status:** todo

## Start Here

Run one promotion against a fake Convex transport that loses the finalize response, then recover the exact terminal result from status without duplicating the release.

## Objective

Continuously coalesce settled PostgreSQL changes into resilient catalog publication attempts and reconcile every attempt to a durable terminal state.

## Context

The worker needs a production runner between the settled causal watermark and Convex's staging protocol. It must tolerate restarts and ambiguous network outcomes, avoid duplicate publications, and target the newest safe state without wasting work on every intermediate sequence.

## Requirements

- Record a durable PostgreSQL publication request/attempt ledger keyed by organization, lane, settled watermark, content identity, and operation identity.
- Coalesce pending catalog requests so the next attempt targets the highest available settled watermark; never activate a lower watermark after a higher one is confirmed.
- Poll often enough to target p95 catalog activation under one minute after settlement without creating one attempt per row.
- Claim attempts with bounded leases and claim tokens, reject stale acknowledgements, and retry retryable transport/server errors with bounded exponential backoff and jitter.
- Assemble the deterministic release once per attempt and persist enough identity/progress to resume from the first unacknowledged batch after restart.
- Send start, batches, and finalize through a narrow server-side Convex transport with bounded timeouts and no provider-specific behavior.
- Reconcile ambiguous responses with authenticated status before retrying a terminal operation.
- Store every attempt through `published`, `unchanged`, `failed`, or `rolled_back`, including exact Convex receipts and safe internal failure classification.
- Do not retry deterministic contract/authentication/block failures indefinitely; mark them terminal and alert while the previous release remains active.
- Refresh unchanged observation freshness without republishing immutable content.
- Prevent more than one active catalog attempt for the approved organization/deployment while allowing a newer pending watermark to coalesce behind it.
- Expose safe health/status facts for operations: settled watermark, requested watermark, active attempt age/state, last activated watermark/time, last unchanged observation, retry time, and delayed-vendor count.

## User-Facing Behavior

Settled catalog changes appear reactively after atomic activation. Retryable failures delay the update while the prior release remains readable; permanent failures never surface partial data.

## Interface Contract

The catalog promotion runner accepts the approved organization/deployment mapping, a settled-watermark repository, the release assembler from `002`, a Convex publication transport matching `003`, a clock, and alert/status sinks.

Its durable ledger exposes claim, heartbeat, progress acknowledgement, terminal acknowledgement, stale-attempt recovery, and coalesced-next-watermark operations. It returns a bounded cycle result suitable for the existing worker runtime rather than running an uninterruptible loop inside a provider worker.

## Acceptance Criteria

- [ ] Multiple settled changes arriving close together coalesce into a publication of the highest safe watermark.
- [ ] A worker restart resumes at the first unacknowledged operation without duplicating staged entities or publication ledger rows.
- [ ] A lost start, batch, or finalize response is resolved through status and reaches the correct terminal PostgreSQL state.
- [ ] Exact replay is harmless; stale claims and lower-watermark activations are rejected.
- [ ] Retryable errors back off and recover, while deterministic failures terminate and leave the prior Convex release active.
- [ ] Unchanged content records a terminal `unchanged` attempt and advances observation freshness without a new immutable release.
- [ ] The existing runtime schedules catalog promotion independently of provider cycles and reports the required safe health facts.
- [ ] Timing tests demonstrate the one-minute service target under normal settled, healthy conditions.

## Verification

`npm run test:database && npm run test:services && npm run test:worker && npm run test:convex`
