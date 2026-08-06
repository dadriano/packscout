# Task: Import Cursor Pages Idempotently

**ID:** data-pipeline/005  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/004](004-manage-provider-configurations.md)  
**Blocks:** [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/012](012-operate-imports-in-admin.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md)  
**Estimated scope:** large  
**Status:** todo

## Objective

PackScout can backfill and incrementally import provider cursor pages without losing, duplicating, or partially acknowledging source data when requests, validation, persistence, or processing fail.

## Context

The first adapter performs an HTTP GET with `platform` and an opaque cursor after the first accepted page. A new provider starts without a cursor and drains every available page until it reaches the provider head. Later runs resume from the durable checkpoint. Raw source pages must be durable before the cursor advances, and individual record failures must not trap the provider on a poison page.

Runs may start from the five-minute scheduler or from an authorized manual action. The same workflow, validation, idempotency, and audit behavior applies to both. Exactly one run may execute for a provider configuration at a time.

## Requirements

### Run ownership and provider requests

- Create run states `queued`, `running`, `succeeded`, `incomplete`, and `failed`, with origin `scheduled` or `manual`, configuration revision, actor when present, start and finish times, counters, and bounded error summary.
- Acquire exclusive execution ownership per provider configuration before the first request. Return a stable conflict for a manual request when a run is active and coalesce scheduled triggers without starting overlapping work.
- Start a new configuration without a cursor; use the stored opaque checkpoint for every later run; never derive a cursor from timestamps, IDs, or source payload content.
- Send platform and cursor through the registered adapter with the configured authentication mode, bounded request time, bounded retries for transient failures, and explicit classification of authentication, rate-limit, timeout, unreachable, status, JSON, and contract failures.

### Page durability and progress

- Persist the complete raw page and its source hash before processing records. Validate each envelope, record valid and invalid outcomes, then atomically advance the durable cursor to the accepted `next_cursor`.
- Continue fetching while `has_more` is true. Reject non-advancing cursors and continuing empty pages to prevent infinite loops. Finish only after an accepted `has_more: false` page reaches the provider head.
- Import every valid catalog, pull, and sale record through registered mapping and projection boundaries; quarantine invalid records without rolling back unrelated valid records.
- Mark a run `incomplete` when it reaches the provider head with quarantined records, `succeeded` when every record is accepted or idempotently duplicated, and `failed` when it cannot durably accept the next page or reach the head.

### Audit and safety

- Preserve the original terminal run result as audit history. Later quarantine resolution changes outstanding-quality counts without rewriting the historical run outcome.
- Let a run that already owns an immutable configuration revision finish after the current configuration is disabled or archived; do not begin another run afterward.
- Exclude bearer tokens, raw payloads, usernames, wallet addresses, and unbounded response bodies from errors, logs, metrics, and audit records.

## User-Facing Behavior

No direct browser behavior in this task. Operator surfaces later receive stable run state, progress counts, current page number, request and response cursor previews, last activity time, failure class, retryability, and whether the provider head was reached.

## Interface Contract

The run service accepts an enabled configuration ID and origin plus an authenticated actor for manual work. It returns a run identity or an active-run conflict. The adapter receives endpoint, platform, current cursor presence, and server-side authentication context and returns a validated provider page.

For each page the workflow publishes durable facts in this order: raw page accepted, record outcomes recorded, canonical writes committed, cursor checkpoint advanced, page completed. Projection services receive protected source-record references plus classified adapter candidates. They do not make provider requests or own cursor state.

## Acceptance Criteria

- [ ] A no-cursor provider backfills multiple pages to `has_more: false`, stores every raw page before acknowledgement, and resumes the next run from the final opaque cursor.
- [ ] Replaying a page or retrying after a crash produces no duplicate current records or revisions and leaves cursor, page, run, and counters consistent.
- [ ] Valid records commit while invalid records enter quarantine, the cursor advances, and the terminal run becomes incomplete rather than blocked or falsely successful.
- [ ] Authentication failure, rate limiting, timeout, unreachable endpoint, invalid JSON, invalid page contract, non-advancing cursor, and persistence failure produce distinct stable outcomes without leaking secrets or raw data.
- [ ] Manual and scheduled triggers share one workflow, overlapping execution is prevented, and disabling a configuration permits only its already-active run to finish.
