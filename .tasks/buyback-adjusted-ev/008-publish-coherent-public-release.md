# Task: Publish One Coherent Public Release

**ID:** buyback-adjusted-ev/008
**Depends on:** buyback-adjusted-ev/006, buyback-adjusted-ev/007
**Blocks:** buyback-adjusted-ev/009, buyback-adjusted-ev/010, buyback-adjusted-ev/012
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including canonical publication, read-model replacement, ranking, and failure verification
**Status:** done

## Start Here

Stage one complete `data_release_v3` fixture and prove that every EV value, version, count, hash, search row, detail, and aggregate reconciles before activation.

## Objective

Every public PackScout read uses one atomically activated postprocessed release whose metrics, confidence, availability, sorts, summaries, and details all reference coherent completed buyback-adjusted revisions.

## Context

PostgreSQL remains canonical authority and Convex remains a rebuildable aggregate read database. The production publisher must replace the current mock-only path and prevent partial, stale, mixed-method, or protected calculation data from becoming public.

## Requirements

### Canonical publication

- Read one repeatable canonical state containing product, price, completed EV revision, vendor EV, availability, actions, categories, collectibles, and freshness.
- Stage sanitized `data_release_v3` entities without raw events, provider payloads, formulas, protected evidence, credentials, or user data.
- Reconcile entity counts, references, calculation versions, arithmetic, hashes, configuration, search projections, and batch receipts before completion.
- Activate only a complete release atomically and retain the previous coherent release for environment-scoped rollback.
- Make identical replay unchanged and conflicting replay fail without moving the active pointer.

### Public reads and ranking

- Rank default opportunities and EV sorts by signed buyback-adjusted EV dollars, highest first, with deterministic public-ID ties.
- Exclude unavailable, expired, sold-out, and disabled repacks from EV opportunities and positive-EV KPI counts.
- Keep unavailable repacks discoverable with their public reason and keep sold-out historical EV visible without ranking or outbound action.
- Exclude unavailable estimates from EV medians and use the same eligibility rules in vendor and category summaries.
- Preserve bounded filtering, pagination, desired-collectible matching, category hierarchy, saved state, and Heat behavior.

### Integrity and lifecycle

- Require every available estimate in one release to use the exact new method and confidence-policy versions.
- Reject mixed methods, malformed metrics, divergent search/detail projections, stale active estimates, and protected fields.
- Keep read budgets bounded at supported release and desired-collectible capacities.
- Fail catalog reads safely when active release state is incomplete or internally inconsistent.

### Deadline safety

- Materialize expiry transitions and also compare the request clock with each current estimate's deadline so a missed transition fails closed.
- Ensure an already-open browser converts a current estimate to unavailable at its deadline without a page reload or misleading live announcement.

### Maintenance-gated cutover

- Prepare the recomputed canonical V3 dataset and immutable application artifacts before entering maintenance.
- Gate public traffic at the routing layer while deploying V3 Convex code, publishing and activating V3, deploying the matching application, and verifying the private candidate origin.
- Keep user-owned saves and authentication records in their existing shared tables without purge, copy, reinterpretation, or dual write.
- Leave maintenance only after the matching application and V3 release pass read-back; on failure, restore V2 code and its retained pointer before reopening traffic.
- Retire old code and V2 release data only after task 013 certification and the recorded rollback window.

## User-Facing Behavior

Users can continue browsing when individual repacks lack PackScout EV. During the bounded clean-cutover window they see an explicit maintenance state rather than a mixed page; rankings otherwise include only active, current, complete buyback-adjusted estimates, and sold-out results remain historical and non-actionable.

## Interface Contract

The publisher reads completed current revisions from task 006 and emits only task 007 contracts. Public queries return one active release identity and aligned PackScout EV projection across every envelope.

Within one environment, activation is the sole boundary that changes the public release pointer. The routing maintenance gate prevents users from observing the code-and-pointer sequence, so no runtime reads both contracts and user-owned saved data remains in place.

## Acceptance Criteria

- [x] A complete new release stages, validates, activates, reads back, refreshes, replays, fails, and rolls back without partial visibility.
- [x] Rankings, KPIs, medians, summaries, null ordering, unavailable rows, sold-out history, and vendor EV follow the approved rules.
- [x] Tampered arithmetic, versions, references, counts, hashes, search rows, details, batches, and protected data fail closed.
- [x] Public reads remain bounded and preserve catalog, desired-collectible, saved-item, Heat, pagination, and category behavior.
- [x] No pre-buyback, mixed-method, raw, protected, or proprietary input reaches the active release, and maintenance-gated rollback never exposes mismatched contracts or loses saves.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — Convex data_release_v3 lifecycle (idempotent hash-chained staging, reconciliation, atomic activation with retained previous pointer, rollback), public v3 queries with signed-EV ranking and server-side deadline fail-closed conversion, services release assembler/publisher composing EV solely from the task-006 publication-eligible read, maintenance-gated cutover runbook structurally incapable of touching saves/auth tables, signed HTTP transport with key-gated v3 routes and byte-stable replay, Prisma canonical-catalog adapter with repeatable readAt snapshots, and a cross-runtime protocol parity test.
- Divergences: (1) no v2-style observation-refresh operation — v3 releases are immutable, a new snapshot is a new release; (2) Heat presents an explicit unavailable state on v3 views until heat republication aligns to v3 (heat frames bind to v2 catalog manifests; wiring them across would violate heat alignment invariants) — follow up in 009/012; (3) vendor_reported_ev_percent sort is INVALID_QUERY — the v3 contract has no vendor percent projection by design; (4) 512 KiB HTTP body cap with fail-closed oversized batches; (5) v3 path constants live in a new contracts file because data-release-v3.ts is task-007-owned; (6) lifecycle read endpoints live in a separate dataReleaseV3Read module. Known non-regression: services test:volume (v2 lane) exceeds its 60s wall-clock budget on this machine at clean HEAD too — pre-existing, machine-load-sensitive.
- Verification: npm run test:convex (22 files, 145 tests), services unit 542, contracts 177, database 118, root typecheck, lint, ratchet 0 new findings — key gates independently re-run by the orchestrator in the worktree. Task file predates a ## Verification anchor; the convex+services suites are the fallback anchor.
