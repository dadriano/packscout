# Task: Persist Source and Canonical History

**ID:** data-pipeline/003  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md)  
**Blocks:** [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout durably preserves replayable source evidence for ninety days and indefinite canonical history while exposing one trustworthy current projection for each accepted provider entity.

## Context

The repository has no persistence layer. The data pipeline needs a durable model that can support full backfills, five-minute incremental imports, idempotent retries, record corrections, unresolved relationships, calculation evidence, operator audit, and automatic source-data expiry. The model must support the sample feeds without copying each nested provider schema into shared storage.

Raw source data can contain public usernames and wallet addresses. Raw pages and quarantined payloads are retained for ninety days under restricted server-side access. Canonical events retain only a pseudonymous provider actor key when actor correlation is required; they do not retain source usernames or raw wallet addresses.

## Requirements

### Durable source and projection records

- Persist versioned provider configurations, active configuration identity per platform, current cursor checkpoint, run state, request and response cursors, page state, record outcomes, actor audit, and timestamps.
- Persist each accepted raw page and its catalog, pull, and sale records without changing nested source data; attach a source hash, provider configuration revision, platform, run, page, record kind, external identity, and expiration time.
- Persist quarantine metadata and protected source references separately from canonical projections so a malformed record cannot corrupt the current product view.
- Persist revision history plus current projections for platforms, purchasable packs, supporting catalog assets, pulls, sales, and PackScout EV estimates.
- Use platform, canonical record kind, and external identity as the stable canonical identity. Allow a single source catalog record to produce multiple stable projections when a provider exposes independently purchasable variants inside one envelope.

### Consistency, retention, and isolation

- Create a new canonical revision only when accepted canonical content or its provenance changes; repeated equivalent input is a no-op whose run counters still record the duplicate.
- Preserve nullable and unresolved source relationship keys. Resolve relationships later without discarding the event or rewriting source evidence.
- Retain canonical history and audit metadata indefinitely; make raw payload and quarantine-payload expiry enforceable without deleting canonical projections, run summaries, validation reasons, or audit records.
- Apply single-organization ownership to every protected record and enforce tenant scope at service and persistence boundaries even though V1 has one organization.
- Provide transactions that keep current projections, revision history, source provenance, cursor state, and run counters consistent under retry, concurrency, and failure.

## User-Facing Behavior

No direct user-facing behavior. Downstream admin pages can show current configuration, run history, freshness, quarantines, canonical revision timestamps, and calculation provenance without reading raw provider JSON.

## Interface Contract

Persistence services expose transport-neutral operations for configuration revision lifecycle, run/page creation, raw-page acceptance, record outcome recording, cursor checkpoint advancement, canonical revision upsert, current projection lookup, unresolved-link reconciliation, EV revision upsert, and retention expiry.

Every canonical revision links to its source record and contains `platform_key`, `record_kind`, `external_id`, `source_updated_at`, `source_collected_at`, `accepted_at`, and a deterministic content identity. Current projections point to one accepted revision. Raw payload operations are server-only and return protected references to callers that do not hold raw-data access.

## Acceptance Criteria

- [x] Reprocessing an unchanged page creates no duplicate canonical revisions, while changed source content creates a new revision and atomically advances the current projection.
- [x] Pulls or sales with missing or not-yet-known pack relationships persist successfully and link when a matching pack projection arrives later.
- [x] Raw pages and quarantine payloads can expire after ninety days without removing canonical history, current projections, run summaries, validation reasons, or audit evidence.
- [x] Canonical actor data contains no source username or raw wallet address, and raw payloads cannot be reached through browser-facing persistence operations.
- [x] Concurrent and failed writes preserve one active configuration per platform, one durable cursor checkpoint per configuration, consistent run counters, and tenant isolation.

## Spec Compliance

- The Drizzle schema and append-only migration create 21 PostgreSQL tables for provider history, protected evidence, outcomes, quarantine, canonical revisions/current pointers, auth, audit, and operational state.
- Durable repositories implement idempotent raw/source acceptance, immutable canonical revision history, multi-projection provenance, unresolved relationship reconciliation, cursor/run consistency, and 90-day evidence expiry.
- Composite tenant constraints, scoped repository guards, actor pseudonymization, canonical PII rejection, and the protected-evidence-only export enforce the required isolation and data boundary.
- Embedded PostgreSQL integration tests prove replay/change behavior, deferred relationships, rollback consistency, retention, last-admin/session behavior, and cross-tenant rejection. Production PostgreSQL 16+ remains an environment deployment check, not a schema or code gap.
- Database tests, migration check, lint, typecheck, build, framework ratchet, dependency boundaries, and the canonical verification gate pass.
