# Task: Quarantine and Retry Invalid Records

**ID:** data-pipeline/006  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/005](005-import-cursor-pages-idempotently.md)  
**Blocks:** [data-pipeline/012](012-operate-imports-in-admin.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** medium  
**Status:** done

## Objective

One malformed or unmappable source record never blocks a platform import, and authorized operators can retry it safely from retained source evidence without rewinding the provider cursor.

## Context

The approved ingestion policy persists the raw page, imports valid records, advances the cursor, and quarantines invalid records. Raw quarantine payloads expire after ninety days, while validation reasons, retry history, resolution outcome, and canonical provenance remain available as audit evidence.

Quarantine applies to envelope validation and provider-specific mapping or projection failures. Insufficient but structurally valid EV inputs do not quarantine a pack; they produce an unavailable EV reason through the calculation task.

## Requirements

### Quarantine evidence and retry

- Create one quarantine entry per invalid source record and failure stage, linked to provider configuration revision, platform, run, page, source record, record kind, external identity when parseable, and protected raw-data expiry.
- Store a stable reason code, field path, bounded sanitized explanation, first and latest failure times, attempt count, lifecycle state, and resolution metadata without copying the full raw payload into logs or browser-facing fields.
- Support retrying one entry or a bounded selected set from the retained raw source record through the current validated adapter mapping and canonical projection boundaries.
- Preserve provider cursor position during retry. A successful retry creates or updates the canonical revision idempotently and marks the quarantine entry resolved; a failed retry records another bounded attempt and returns it to open.

### Lifecycle and permissions

- Prevent concurrent retries of the same entry and return stable conflicts when an entry is already retrying, resolved, expired, outside tenant scope, or no longer has retained source data.
- Keep the original run's terminal status immutable. Expose outstanding, resolved, and expired counts separately so an incomplete historical run can have all of its quarantines resolved.
- Expire protected raw payload access at ninety days. Mark an unresolved entry expired and preserve its reason, identifiers, attempts, and audit metadata after the payload is removed.
- Permit administrators and data operators to start retries; prohibit both roles from retrieving full raw payloads through browser APIs.

## User-Facing Behavior

Operators can identify which provider, run, page, record kind, and source identity failed; read a sanitized reason and field path; see retry attempts and remaining retention time; and start an allowed retry. Retry pending, success, repeated failure, conflict, expired, and permission-denied outcomes are explicit. Full usernames, wallets, bearer tokens, and raw JSON are never rendered.

## Interface Contract

Quarantine reads return entry ID, provider and run references, record kind, bounded source identity, reason code, field path, sanitized explanation, state, attempt count, first and latest failure times, raw expiry, and resolution summary. Retry accepts quarantine IDs and authenticated actor identity, then returns per-entry outcomes.

The retry service reads raw data through a protected server-only reference, resolves the registered adapter version, validates and maps the record, and calls the same idempotent projection operation used by normal ingestion. It never fetches an external page or changes a provider cursor.

## Acceptance Criteria

- [x] A mixed page imports valid records, creates bounded quarantine entries for invalid records, advances the cursor, and records an incomplete run with accurate counts.
- [x] Retrying a repaired mapping resolves the entry and writes the canonical projection exactly once without changing the provider cursor or historical run result.
- [x] Repeated, concurrent, resolved, expired, unauthorized, and cross-tenant retry attempts return stable outcomes and preserve consistent attempt history.
- [x] Ninety-day expiry removes protected payload access while preserving non-sensitive audit metadata and an explicit expired state.
- [x] Browser responses, logs, metrics, notifications, and errors never contain full raw payloads, usernames, wallet addresses, or secrets.

## Spec Compliance

- Added tenant-scoped, browser-safe quarantine list/detail/count contracts and bounded single/bulk retry commands for administrators and data operators.
- Added durable retry attempts with one-running-attempt enforcement, explicit conflict/expired/resolved outcomes, and database-level tenant foreign keys.
- Revalidated both linked records and previously unlinked invalid envelopes through the current mapper and shared projection boundary, materializing repaired source evidence exactly once without cursor or run mutation.
- Added controllable retention expiry, deadline-race protection, safe audit metadata, and focused service/database integration coverage.
