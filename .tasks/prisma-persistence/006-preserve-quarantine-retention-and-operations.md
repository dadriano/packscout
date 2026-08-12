# Task: Preserve Quarantine, Retention, and Operations

**ID:** prisma-persistence/006  
**Feature PRD:** [Prisma Persistence](./_index.md)  
**Depends on:** [prisma-persistence/003](003-preserve-identity-and-provider-controls.md), [prisma-persistence/004](004-preserve-import-coordination-and-worker-queues.md), [prisma-persistence/005](005-preserve-ingestion-and-canonical-history.md)  
**Blocks:** [prisma-persistence/007](007-cut-over-packscout-runtimes.md)  
**Estimated scope:** large  
**Status:** todo

## Objective

PackScout retains safe quarantine recovery, protected-payload retention, operational alerts, health history, and organization-scoped admin reads through Prisma.

## Context

Operational persistence spans retryable quarantines, protected evidence access, retention executions, operational events, admin alerts, provider and run read models, pagination, and health summaries. Multiple workers may retry or expire evidence concurrently, while operators acknowledge and resolve alerts or inspect sanitized history.

The cutover must preserve disjoint claims, one running retry per quarantine, permanent-evidence exemptions, alert deduplication, stable keyset reads, and bounded safe diagnostics. It must not make raw payloads, source identities, credentials, or cross-organization records available through admin-facing queries.

## Requirements

### Quarantine and retry

- Preserve organization-scoped quarantine creation, classification, bounded evidence, status history, attempt history, retry eligibility, and terminal outcomes.
- Permit at most one running attempt per quarantine and let concurrent workers claim disjoint eligible retries.
- Preserve single-record retry through the same canonical persistence semantics used by page ingestion.
- Reject foreign, stale, expired, or already-completed attempt ownership without changing quarantine or canonical state.
- Keep full protected source evidence server-side and return only bounded sanitized diagnostics to operator-facing consumers.

### Retention

- Preserve the configured protected-payload retention boundary and permanent-evidence exemptions.
- Let concurrent retention workers claim disjoint eligible records and recover expired claims safely.
- Make payload expiry, execution counters, completion, and safe failure evidence atomic and restartable.
- Preserve source, outcome, audit, and canonical history after protected payload bytes expire.

### Operational reads and alerts

- Preserve organization-scoped provider, run, page, quarantine, outcome, health, event, retention, and alert read models with stable ordering and keyset pagination.
- Preserve alert deduplication, occurrence history, acknowledgement, resolution, recovery, and safe restart behavior.
- Preserve bounded filters, not-found outcomes, permission outcomes, and sanitized error details consumed by admin services and routes.
- Prevent protected payloads, secrets, raw actor identities, or cross-organization identifiers from entering browser-safe results, logs, events, or alert metadata.

## User-Facing Behavior

Operators see the same quarantine detail, retry, retention, provider health, import history, alert acknowledgement, alert resolution, pagination, permission, and safe diagnostic behavior. This task does not add or redesign admin pages.

## Interface Contract

Quarantine, retention, operational, and admin-read services continue using their current organization-scoped ports, cursor shapes, state vocabularies, and stable outcomes. Retry and retention claims return bounded work plus ownership evidence; only the active owner may update that work.

Task `007` composes these implementations into admin and worker runtimes after direct tenant, contention, retention, and sensitive-data regressions pass.

## Acceptance Criteria

- [ ] Quarantine creation, listing, detail, one-running-attempt enforcement, retry success or failure, and attempt history preserve their current organization-scoped outcomes.
- [ ] Concurrent quarantine and retention workers claim disjoint work, recover expired claims, reject stale owners, and produce no duplicate completed effects.
- [ ] Retention expires only eligible protected payloads while preserving permanent evidence and all required durable history.
- [ ] Operational reads, filters, cursors, alerts, occurrence history, acknowledgement, resolution, and recovery remain deterministic and restart-safe.
- [ ] Browser-safe results, logs, failures, events, and alerts expose no secret, raw payload, raw actor identity, or cross-organization data.

## Verification

- Run focused quarantine, retry, retention, admin-read, operational-event, alert, and health repository and service suites.
- Run real PostgreSQL contention, stale-owner, keyset-pagination, cross-organization, permanent-evidence, deduplication, and sensitive-data regressions.
- Run affected database, service, admin, and worker checks through `npm run verify:framework`.
