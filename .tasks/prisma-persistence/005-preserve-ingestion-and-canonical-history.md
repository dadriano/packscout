# Task: Preserve Ingestion and Canonical History

**ID:** prisma-persistence/005  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/002](002-establish-prisma-runtime-and-test-foundation.md)  
**Blocks:** [prisma-persistence/006](006-preserve-quarantine-retention-and-operations.md), [prisma-persistence/007](007-cut-over-packscout-runtimes.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout imports provider pages through Prisma without losing atomicity, provenance, idempotency, canonical revision history, relationship recovery, or bounded large-page performance.

## Context

One accepted provider page can create immutable page evidence, source identities, observations, accepted or quarantined outcomes, canonical entities and revisions, current-revision pointers, projection links, relationships, EV recomputation requests, run counters, and a new cursor checkpoint. Those writes become visible together only while the caller owns the run.

The existing persistence path batches a 550-record page in fewer than 80 database statements. Replacing that path with record-by-record ORM operations would preserve types while breaking the operational contract. This task owns ingestion and its batch writer together so transaction, ordering, and performance behavior cannot diverge.

## Requirements

### Atomic page persistence

- Commit raw page evidence, record observations, outcomes, quarantines, canonical changes, relationships, EV requests, counters, and cursor advancement as one ownership-checked transaction.
- Leave every page write and the cursor unchanged when any step fails or the caller no longer owns the run.
- Advance an accepted cursor exactly once and preserve page idempotency across crash recovery and retry.
- Keep standalone quarantines and source-linked quarantines correctly represented without double-counting run or page outcomes.

### Immutable and canonical history

- Preserve immutable source identity, observation history, protected payload hashing, actor pseudonymization, and source-to-canonical provenance.
- Create no new canonical revision for unchanged content; create exactly one ordered revision for accepted changed content and retain all prior revisions.
- Keep the current canonical pointer on the latest accepted revision within the same organization and canonical identity.
- Preserve unresolved relationships for later reconciliation and resolve same-page and later-arriving targets without cross-organization linkage.
- Preserve provider-reported EV evidence separately from PackScout Estimated EV inputs and results.

### Batching and contention

- Keep per-page database work set-based and bounded as record count grows rather than issuing a sequence of database round trips per record.
- Preserve deterministic lock and revision ordering so competing writes cannot create duplicate revisions or deadlock through inconsistent ordering.
- Keep the existing 550-record page below 80 database statements while preserving all evidence, counters, relationships, and replay behavior.
- Preserve chunk-boundary behavior for pages larger than a single safe database-parameter batch.

## User-Facing Behavior

Operators and downstream consumers see the same accepted, duplicate, revised, quarantined, incomplete, failed, and recovered outcomes. Cursor progress, counts, canonical history, provenance, and EV availability do not change.

## Interface Contract

The import service supplies an organization-scoped run owner, immutable configuration revision, page identity, protected raw evidence, classified records, projection commands, relationship candidates, record outcomes, and the accepted next cursor. The persistence boundary returns stable page, replay, ownership-loss, conflict, and persistence-failure outcomes.

Tasks `004` and `006` consume the committed run, quarantine, health, and EV work but do not write around this page transaction. Task `007` wires the proven Prisma implementation into the worker runtime.

## Acceptance Criteria

- [x] A valid mixed page makes all evidence, outcomes, canonical history, relationships, EV work, counters, and its cursor visible together exactly once.
- [x] Failure, stale ownership, foreign ownership, and conflicting page replay leave no partial page writes or cursor movement.
- [x] Identical replay, changed content, same-page relationships, later relationship reconciliation, and cross-run replay preserve current identity and revision semantics.
- [x] Direct cross-organization operations fail without leaking or linking protected evidence, source records, canonical records, or relationships.
- [x] A 550-record page remains below 80 database statements and passes evidence, counter, chunk-boundary, rollback, and replay assertions.

## Verification

- Run focused persistence and import-service scenarios for page idempotency, crash recovery, ownership loss, atomic rollback, revision ordering, relationship reconciliation, and quarantine accounting.
- Run real PostgreSQL contention and chunk-boundary tests, including the measured 550-record statement-budget regression.
- Run affected database, service, and worker lint, typecheck, and integration checks through `npm run verify:framework`.

## Spec Compliance

- Related specs reviewed: none
- Alignment: migrated atomic ingestion, source and canonical history, projections, relationships, quarantines, EV requests, counters, and cursor checkpoints to one Prisma transaction with parameterized set-based PostgreSQL operations
- Divergences: none; public repository naming remains transitional until tasks `007` and `008`, with no dual persistence path
- Verification: ten real PostgreSQL persistence tests and seven service integration tests cover ownership, rollback, independent-client revision contention, replay, crash recovery, tenant isolation, provenance, relationships, and EV history; the 550-record page commits in 32 statements against the fewer-than-80 budget
