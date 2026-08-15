# Feature: PostgreSQL to Convex Promotion

## Start Here

Open `postgres-convex-promotion/001`, define one public-affecting change and its derived obligations, and finish with a durable settled-watermark contract that does not depend on provider-run completion.

**Progress:** 4/7 tasks complete

## Context

PackScout's provider workers write authoritative canonical history to PostgreSQL, while the public dashboard reads a sanitized, immutable release from Convex. The missing production boundary is a promotion runner that detects public-affecting canonical changes, waits for every causally related derivation to reach a valid business outcome, assembles deterministic release content, publishes it in bounded idempotent batches, reconciles it, and atomically activates it. Direct provider-to-Convex writes would expose partial imports, couple provider retries to public storage, and make recovery ambiguous.

This feature completes that boundary without creating a second public data model. It implements the production publication and Heat paths already required by `repack-dashboard/002` and `repack-dashboard/013`, while preserving PostgreSQL as the only canonical authority and the existing Convex public query contracts.

## Resolved Decisions

- Every public-affecting PostgreSQL change receives a database-ordered causal sequence in the same transaction as the authoritative write.
- A sequence is settled only when all derived obligations caused at or before it have reached a terminal business outcome. A legitimate unavailable metric is publishable; an infrastructure or technical derivation failure blocks advancement.
- Provider-run completion is not a publication boundary because derived work can remain queued after a provider cycle ends.
- Catalog promotion targets the highest contiguous settled watermark and coalesces superseded requests. It never streams raw rows or provider payloads into Convex.
- Catalog content is a deterministic immutable release, written in bounded idempotent batches, fully reconciled, then exposed by one atomic active-release pointer change.
- Publication failure leaves the prior complete release active. Unchanged content advances observation freshness without rewriting immutable release rows.
- The initial canonical activation requires a complete backfill and settled derived work for every enabled provider. Later releases may retain the last settled data for a delayed provider and report `delayedVendorCount`.
- Promotion runs continuously with a catalog target of p95 under one minute after the causal watermark settles.
- Repack Heat is an independent one-minute aggregate lane built only from settled PostgreSQL observations. Raw observations never enter Convex.
- Heat uses the existing 15-minute current window, 24-hour baseline, and 15-minute fail-closed expiry. A Heat frame must identify the active catalog release it describes; misaligned or stale Heat is unavailable.
- Catalog activation never waits for Heat. Heat failure cannot block catalog activation, and catalog failure keeps the previous aligned catalog/Heat pair readable until Heat expires.
- One approved PackScout organization and deployment mapping is resolved server-side. Neither the public API nor Convex accepts a tenant selector.

## Out of Scope

- Per-row or per-provider dual writes from ingestion workers to Convex.
- Raw provider payloads, raw pulls, actor data, credentials, internal run IDs, tenant identifiers, or quarantine details in Convex.
- Convex-to-PostgreSQL writes or treating Convex as canonical storage.
- A second public DTO, a replacement public query model, or frontend behavior changes.
- Atomic coupling between catalog activation and Heat publication.
- New provider transports, provider-specific projection branches, or a generic future event-stream platform.
- The public-configuration proposal/review UI; the publisher consumes only an already approved, versioned PostgreSQL configuration.
- Destructive removal of the existing guarded mock seed or historical canonical data.

## Tasks: Settlement and Publication

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Establish causal public-change settlement | large | 2–4 days | done | none |
| 002 | Assemble deterministic catalog releases | large | 2–4 days | done | 001 |
| 003 | Stage and atomically activate Convex releases | large | 2–4 days | done | none |
| 004 | Run and reconcile catalog promotions | large | 2–4 days | in_progress | 002, 003 |

## Tasks: Heat and Operations

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 005 | Normalize settled live Heat observations | medium | 1–3 days | done | 001 |
| 006 | Publish release-aligned Heat frames | large | 2–4 days | todo | 004, 005 |
| 007 | Certify recovery and live readiness | large | 2–4 days | todo | 004, 006 |

## Build Order

1. Build `001` and `003` in parallel because PostgreSQL settlement and Convex staging have disjoint ownership.
2. After `001`, build `002` and `005` in parallel: catalog assembly and Heat normalization share the settled watermark but produce separate contracts.
3. Build `004` after both catalog sides exist.
4. Build `006` after catalog activation and normalized Heat observations are available.
5. Finish with `007` to prove reconciliation, recovery, retention, expiry, and launch gates across both lanes.

## Parallel Groups

- Group A (no dependencies): `postgres-convex-promotion/001`, `postgres-convex-promotion/003`
- Group B (after `001`): `postgres-convex-promotion/002`, `postgres-convex-promotion/005`
- Group C (after `002` and `003`): `postgres-convex-promotion/004`
- Group D (after `004` and `005`): `postgres-convex-promotion/006`
- Group E (after `004` and `006`): `postgres-convex-promotion/007`

## Next Action

Complete `004-run-and-reconcile-catalog-promotions.md`, then reuse that durable runner ledger for the independent Heat lane.
