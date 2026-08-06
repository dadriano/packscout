# Task: Operate Imports in the Admin

**ID:** data-pipeline/012  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/001](001-protect-data-operations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Write the operator walkthrough for a stale platform with an incomplete run: inspect health, open the run, understand the quarantined record, retry it, start a manual catch-up, and verify recovery.

## Objective

Administrators and data operators can understand provider health, inspect import history, start manual imports, and resolve retryable quarantines without accessing secrets or full raw payloads.

## Context

The system distinguishes freshness from data quality. A provider can reach its head and remain fresh while an invalid record is quarantined, or become stale after repeated endpoint failures with no quarantine. Run states are queued, running, succeeded, incomplete, and failed. Historical terminal state remains immutable even after its quarantines resolve.

Both administrators and data operators may start manual imports and quarantine retries. Only administrators manage configurations and secrets. Raw payloads can contain usernames and wallet addresses, so the browser receives bounded sanitized diagnostics instead of full JSON.

## Requirements

### Provider and run operations

- Provide an operational overview showing each provider's freshness, quality, schedule, stale threshold, next due time, active run, last attempt, last provider-head time, open quarantine count, and consecutive failures.
- Provide run history with provider, origin, immutable configuration version, state, start and finish times, pages, catalog/pull/sale counts, accepted/unchanged/revised/quarantined counts, head-reached result, and bounded failure class.
- Provide run detail with page progress, sanitized cursor previews, record outcome totals, timeline, quality-resolution counts, and links to related quarantines without returning raw payloads.
- Allow an administrator or data operator to start a manual run for an enabled provider. Explain and surface an active-run conflict without queuing duplicate work.
- List quarantine entries by provider, run, record kind, bounded source identity, reason, field path, state, attempts, first and latest failure, and raw-expiry time.

### Retry, recovery, and interface states

- Allow retry of one or a bounded selected set of open quarantines, with pending, per-record success, repeated failure, conflict, resolved, and expired outcomes.
- Show provider recovery after a head-reaching run and show quarantine resolution separately from the immutable historical incomplete run.
- Use constrained filters and pagination for providers, runs, and quarantine entries so growing history does not require unbounded browser responses.
- Cover loading, empty, active, partial, stale, degraded, forbidden, rate-limited, conflict, failure, recovery, and expired states accessibly.

## User-Facing Behavior

An operator starts from a status overview, drills into a provider or run, and sees what happened in plain language with exact counts and timestamps. Manual Run is disabled while work is active and explains why. Quarantine entries show enough sanitized evidence to understand and retry a mapping failure but do not expose source usernames, wallet addresses, credentials, or raw JSON.

Successful retry visibly resolves the quality item. A later successful import restores freshness. The original incomplete run remains labelled as it occurred, with a separate resolved-quarantine count.

## Interface Contract

Browser APIs expose paginated provider health, run summaries, run detail, page and record counters, and sanitized quarantine summaries. Manual-run creation accepts provider configuration identity and returns a new run or stable active-run conflict. Retry accepts quarantine IDs and returns per-entry outcomes.

Cursor previews are bounded display strings, not inputs for browser-controlled cursor mutation. Raw source references are never serializable through these routes. Role and tenant checks occur before reads and actions.

## Acceptance Criteria

- [ ] Admin and data-operator users can move from provider status to run detail and quarantine resolution with accurate counts, timestamps, immutable run state, and current quality state.
- [ ] Manual runs use the shared ingestion workflow, show active conflicts clearly, and recover stale status only after reaching the provider head.
- [ ] Single and bounded-batch quarantine retries expose per-record progress and outcomes without rewinding cursors or changing historical run state.
- [ ] Full raw payloads, usernames, wallet addresses, bearer tokens, and unbounded error bodies never reach browser responses, rendered state, or client logs.
- [ ] Desktop and mobile browser smoke checks cover navigation, filters, pagination, dialogs, live status feedback, keyboard flow, focus, and no page-level overflow.
