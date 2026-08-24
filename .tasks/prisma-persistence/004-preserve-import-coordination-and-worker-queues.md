# Task: Preserve Import Coordination and Worker Queues

**ID:** prisma-persistence/004  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/002](002-establish-prisma-runtime-and-test-foundation.md)  
**Blocks:** [prisma-persistence/006](006-preserve-quarantine-retention-and-operations.md), [prisma-persistence/007](007-cut-over-packscout-runtimes.md)  
**Estimated scope:** large  
**Status:** done

## Objective

Scheduled imports, manual imports, provider work, and EV recomputation retain durable queue, lease, contention, retry, and recovery behavior through Prisma.

## Context

PackScout coordinates queued and running imports, provider cursors, schedules, provider health, and estimated-EV recomputation in PostgreSQL. Multiple workers may poll concurrently, so persistence must atomically select eligible work, prevent overlapping owners, reject stale workers, recover expired leases, coalesce duplicate demand, and preserve counters and terminal history.

Generated ORM operations do not replace these observable guarantees. This task keeps the queue and scheduler state machines unchanged while moving their persistence to the shared Prisma transaction boundary.

## Requirements

### Import ownership

- Preserve exactly one queued or running import per organization and provider, including manual conflict and scheduled coalescing outcomes.
- Preserve atomic claim, lease renewal, ownership checks, expiry recovery, attempt tracking, terminal completion, and stale-owner rejection.
- Preserve immutable configuration revision ownership and actor evidence for manual work.
- Keep cursors, provider-head state, safe failure summaries, and run counters consistent across retries and restarts.
- Prevent a disabled or archived provider from starting new work while allowing its already-owned run to finish under the current contract.

### Scheduling and health

- Preserve due-work selection, scheduling cadence, enablement, stale thresholds, freshness transitions, and provider health timestamps.
- Let concurrent schedulers claim disjoint eligible work without blocking indefinitely or starting duplicate imports.
- Preserve retryable contention as a normal bounded worker outcome rather than a fatal worker failure.
- Keep organization and provider scope on every schedule, health, claim, and update operation.

### EV recomputation

- Preserve durable recomputation requests, relationship-triggered enqueueing, duplicate coalescing, claim ownership, lease recovery, retry scheduling, and terminal outcomes.
- Preserve the distinction between provider EV evidence and PackScout Estimated EV calculations throughout queue inputs and results.
- Let concurrent workers claim disjoint requests and reject updates from expired or foreign owners.
- Keep counters, timestamps, bounded failures, and restart behavior stable.

## User-Facing Behavior

Operators see the same run conflicts, progress, recovery, freshness, health, and EV recalculation outcomes. This task does not change schedules, labels, calculation rules, or admin interactions.

## Interface Contract

Import, scheduling, health, and EV services continue using their current repository ports and state vocabularies. Claim operations return bounded work plus an ownership token; subsequent mutations succeed only for the active organization-scoped owner. Contention, no-work, stale-owner, conflict, and terminal outcomes retain their existing meanings.

Task `007` composes the Prisma implementations into the worker and admin runtimes only after contention and restart tests pass.

## Acceptance Criteria

- [x] Manual and scheduled imports preserve active-run exclusivity, coalescing, leasing, recovery, counters, and stale-owner rejection under concurrent workers.
- [x] Concurrent schedulers and EV workers claim disjoint eligible work without duplicate processing or indefinite blocking.
- [x] Provider disablement, lease expiry, retry exhaustion, restart, and terminal completion preserve their current durable outcomes.
- [x] EV requests coalesce and recompute without mixing provider-reported values with PackScout calculations or losing provenance.
- [x] Cross-organization and foreign-owner operations fail without changing queue, schedule, health, cursor, or EV state.

## Verification

- Run focused import-run, scheduling, health, and EV repository and service suites through the Prisma integration harness.
- Run real PostgreSQL contention tests with multiple clients for disjoint claims, active-run uniqueness, lease recovery, coalescing, stale ownership, and restart safety.
- Run affected worker and service lint, typecheck, and integration checks through `npm run verify:framework`.

## Spec Compliance

- Related specs reviewed: none
- Alignment: converted import ownership, scheduling, provider health, and estimated-EV recomputation queues to Prisma while retaining parameterized PostgreSQL locking and claim semantics
- Divergences: none; coordinated runtime and cleanup tasks removed the temporary repository names without introducing compatibility reads or writes
- Verification: seven real PostgreSQL tests with independent Prisma clients cover coalescing, disjoint claims, lease recovery, stale ownership, atomic counters, schedule cadence, tenant-scoped health, retry timing, and EV terminal outcomes; focused lint and strict TypeScript pass
