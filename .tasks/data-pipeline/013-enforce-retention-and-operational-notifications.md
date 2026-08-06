# Task: Enforce Retention and Operational Notifications

**ID:** data-pipeline/013  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Write the event matrix for run failed, run incomplete, provider stale, provider recovered, quarantine resolved, and raw retention expired, including deduplication and the V1 admin-notification result.

## Objective

PackScout automatically expires protected source payloads, preserves non-sensitive audit evidence, and reports data-pipeline failures and recoveries through a provider-neutral notification and observability boundary.

## Context

Raw pages and quarantine payloads can contain usernames and wallet addresses and are retained for ninety days. Canonical history, run summaries, validation reasons, and audit records are retained indefinitely. Cleanup must be safe, scoped, observable, and independent from product projections.

V1 delivers alerts inside the admin and emits structured logs and metrics. The notification boundary must support future email, webhook, or other channels without placing channel branches in ingestion, scheduling, or provider adapters.

## Requirements

### Retention and operational events

- Identify raw pages and quarantine payloads whose protected retention expires at ninety days, remove only the protected payload content, and preserve source identity, hash, provider/run/page references, record kind, bounded validation reason, retry history, expiry result, and canonical provenance.
- Mark unresolved quarantines expired when their payload is removed; keep resolved quarantine metadata and historical run status intact.
- Make retention work incremental, tenant-scoped, restart-safe, idempotent, bounded per execution, and observable through counts, duration, latest success, and bounded failures.
- Emit provider-neutral operational events for run failed, run incomplete, provider stale, provider recovered, quarantine resolved, quarantine expired, and retention failed or recovered.
- Route events through one abstract notification contract. Implement an in-admin notification sink for V1 and leave external delivery channels absent.

### Alert lifecycle and observability

- Deduplicate repeated active-condition notifications, update their occurrence count and latest evidence, and resolve an active alert on the matching recovery event without deleting its history.
- Emit structured metrics for run duration and outcome, page and record counts, cursor lag proxy, freshness, quarantine counts and age, retry outcomes, calculation availability, notification state, and retention work.
- Keep logs, metrics, health responses, notifications, and audit events free of bearer tokens, raw payloads, usernames, raw wallet addresses, cookies, passwords, and unbounded provider responses.
- Provide a shallow liveness signal and protected operational detail that distinguishes unconfigured, healthy, stale, degraded, and failed dependencies without exposing secrets.

## User-Facing Behavior

Operators see concise admin alerts for active failed, incomplete, stale, or retention conditions and a visible recovery when the condition clears. Repeated occurrences update one active alert rather than flooding the interface. Alert details link to sanitized provider, run, or quarantine views.

An expired quarantine clearly states that retry is no longer possible because its ninety-day source retention ended. Canonical data and historical evidence remain visible.

## Interface Contract

Operational events contain event kind, organization, provider, related run or quarantine reference, severity, occurred time, deduplication key, bounded sanitized evidence, and recovery key. Notification sinks accept the generic event and return accepted, deduplicated, resolved, or failed without changing ingestion outcomes.

Retention operations accept a cutoff and bounded batch size and return selected, expired, already-expired, failed, and remaining counts. They cannot delete canonical records, current projections, run summaries, or audit metadata.

## Acceptance Criteria

- [ ] A controllable-clock test proves protected raw and quarantine payloads expire at ninety days while canonical history, projections, run summaries, reasons, hashes, and audit evidence remain.
- [ ] Open quarantines become expired, resolved entries retain their resolution metadata, and repeated cleanup is idempotent and tenant-scoped.
- [ ] Failure, incomplete, stale, recovery, quarantine, and retention events produce deduplicated in-admin notifications through one provider-neutral interface.
- [ ] Metrics and protected operational detail distinguish freshness, quality, retry, calculation availability, notification, and retention outcomes without leaking sensitive data.
- [ ] Adding a test notification sink requires no change to ingestion, scheduling, calculation, retention, or provider-mapping branches.
