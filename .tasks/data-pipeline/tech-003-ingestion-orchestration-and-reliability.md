# Technical Spec: Ingestion Orchestration and Reliability

**Spec ID:** tech-003  
**Related tasks:** [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md)  
**Depends on tech specs:** [tech-001](tech-001-runtime-security-and-service-boundaries.md), [tech-002](tech-002-provider-feed-storage-and-history.md)  
**Spec status:** draft

## Purpose

Define how PackScout schedules provider work, walks cursor pages safely, retries transient failures, recovers quarantined records, reports health, sends abstracted notifications, and enforces retention without overlapping or losing progress.

## Current System Context

- There is no worker application, scheduler, queue, import lifecycle, or operational notification implementation.
- The feature decisions set a default five-minute schedule and a fifteen-minute stale threshold.
- Scheduled and manual imports share one provider-level exclusivity rule.
- A page must be durable before its cursor advances, and invalid records must not block valid records on the same trustworthy page.
- Version one notifications are visible in the admin only, but the notification boundary must support later channels.

## Proposed Implementation

### DB-backed work coordination

Run one stateless `apps/worker` process type. Each worker polls for due providers and queued operations, claims work in a short transaction using `FOR UPDATE SKIP LOCKED`, writes a worker lease and heartbeat, then performs network and projection work outside the claim transaction.

Implement the atomic claim as a parameterized PostgreSQL query through the Prisma transaction client because generated Prisma Client operations do not expose `SKIP LOCKED`.

Enforce one queued or running import per provider with a partial unique index. Manual triggers return the existing active run when deduplicated rather than creating parallel work.

Create the partial index in reviewed Prisma migration SQL and verify it in migration integration tests.

### Run lifecycle

Use states `queued`, `running`, `succeeded`, `incomplete`, and `failed`. `incomplete` means durable progress exists but the feed did not reach a terminal cursor; it is the retryable recovery state. `failed` is reserved for non-retryable configuration, contract, security, or safety failures.

Every state transition is a compare-and-set operation against the expected current state. Terminal runs cannot resume; recovery creates a new run linked by `resumes_run_id` and starts from the prior durable cursor.

### Page execution

For each page:

1. Renew the run lease and fetch with a bounded timeout.
2. Validate the page envelope and classify individual record failures.
3. Commit the raw page, source records, quarantines, projections, counters, and next cursor atomically.
4. Release large payload references before requesting another page.
5. Stop on `has_more=false`; otherwise continue from the committed cursor.

Retry retryable fetch failures with bounded exponential backoff and jitter. Do not retry validation, authorization, endpoint policy, cursor-cycle, or payload-limit failures automatically.

### Quarantine retry

A quarantine retry loads its retained source record, re-runs only the relevant mapper and projection path, and writes a separate attempt result. It never rewinds the provider cursor or replays unrelated records.

Bulk retry accepts a reason/platform filter, resolves a bounded batch, and creates independent retry jobs. Authorization and state are checked again when each job executes.

### Health and alerting

Track freshness separately from quality. Freshness derives from last successful page time against `stale_after_seconds`; quality derives from quarantine rate, mapper failures, and reconciliation backlog.

Publish domain notification events through a `NotificationPublisher` interface. The first subscriber stores in-admin alerts. Future email or messaging subscribers can consume the same allowlisted event without changing import logic.

### Retention

Run a daily retention job that clears raw page and source payload JSON at `expires_at`, defaulting to 90 days. It preserves record hashes, normalized provenance, canonical history, quarantine outcome metadata, and aggregate counts.

## Code Changes

### Worker runtime

- Add scheduler, job-claim, lease, backoff, and graceful-shutdown modules under `apps/worker/src`.
- Add handlers for imports, quarantine retries, relationship reconciliation, EV recomputation, notifications, and retention.
- Add a worker entry point that validates runtime config before polling.
- Add process-level signal handling that stops new claims and safely abandons or finishes leased work.

### Shared services

- Add an import state machine and transactional `commitPage` workflow in `packages/services`.
- Add clock, random, adapter, notification, and metrics interfaces for deterministic tests.
- Add a quarantine service with single and bounded-bulk retry commands.
- Add a provider-health projector that computes freshness and quality independently.

## Database / Schema Changes

### Coordination fields and jobs

Extend `import_runs` with `resumes_run_id`, `lease_owner`, `lease_expires_at`, `attempt`, and `next_attempt_at`. Add a partial unique index on `provider_id` where state is `queued` or `running`.

Create `operation_jobs(id, organization_id, kind, subject_type, subject_id, state, requested_by_actor_key, attempt, next_attempt_at, lease_owner, lease_expires_at, payload_json, result_json, created_at, finished_at)` for bounded non-import background operations.

### Provider health

Create `provider_health(provider_id, organization_id, freshness_state, quality_state, last_attempt_at, last_success_at, last_page_at, open_quarantine_count, rolling_quarantine_rate, reconciliation_backlog, updated_at)`.

This is a rebuildable projection. The source of truth remains runs, quarantine, reconciliation, and configuration history.

### Notifications and metrics

Create `operational_events(id, organization_id, event_key, severity, provider_id, run_id, dedupe_key, title, summary, details_json, occurred_at)` and `admin_alerts(id, organization_id, event_id, state, first_seen_at, last_seen_at, occurrence_count, acknowledged_by, acknowledged_at, resolved_at)`.

Use a unique active alert dedupe key so repeated failures update occurrence count and last-seen time instead of flooding the admin.

## Interfaces, APIs, Endpoints

### Worker service commands

- `requestImport({ providerId, trigger, actor })` returns a new or existing active run.
- `claimDueProvider({ workerId, now })` and `claimOperationJob(...)` return short-lived leases.
- `executeImport({ runId, workerId })` owns page walking and terminal state selection.
- `retryQuarantine({ quarantineId, actor })` queues an independent retry operation.
- `runRetention({ before, workerId })` clears eligible raw evidence in bounded batches.

### Notification contract

```ts
interface NotificationPublisher {
  publish(event: OperationalNotification): Promise<void>;
}
```

`OperationalNotification` contains only organization ID, event key, severity, entity references, sanitized summary, dedupe key, and timestamps. It must not contain credentials, raw payloads, full upstream responses, or direct personal identifiers.

## Data Flow

1. The scheduler or admin service requests a run and applies the provider exclusivity constraint.
2. A worker claims the run, resolves the immutable configuration revision, and marks it running.
3. The worker fetches and commits pages until terminal pagination, a retryable interruption, or a non-retryable failure.
4. Health and operational event projections update from committed run outcomes.
5. The notification subscriber creates or refreshes an admin alert; retention later removes only expired raw evidence.

## Error Handling and Edge Cases

- A worker crash leaves a lease to expire; a later worker creates a recovery run from the last committed cursor.
- A manual trigger during a running schedule returns `202` with the active run and `deduplicated: true`.
- A provider disabled after claim stops before the next request and leaves the run incomplete with a configuration-state reason.
- Repeated cursor values, record/page limits, deadline limits, and lease loss stop further network work before another commit.
- Notification persistence failure records a metric and retryable job but does not roll back an already committed import page.

## Testing and Verification

### State and concurrency scenarios

- Two workers racing for one provider produce one active run and one lease owner.
- Crash after fetch but before commit re-fetches safely; crash after commit resumes from the durable next cursor.
- Scheduled and manual triggers deduplicate while different providers continue independently.
- Lease expiry, graceful shutdown, disabled providers, and configuration changes select explicit run outcomes.
- State transitions reject stale writers and terminal-run mutation.

### Recovery and operations scenarios

- Retryable fetch failures back off within bounds and non-retryable failures stop immediately.
- One invalid record is quarantined while valid siblings commit and the cursor advances.
- Single and bulk quarantine retries never rewind cursors or duplicate canonical revisions.
- Stale freshness, high quarantine rate, alert deduplication, acknowledgment, resolution, and notification retry are directly tested.
- Retention clears only expired raw JSON and preserves canonical, audit, and outcome evidence.

## Open Questions and Risks

- Confirm production worker concurrency and provider rate limits before setting defaults beyond one active run per provider.
- Define the maximum pages, records, payload bytes, and wall-clock duration allowed in one run.
- Determine whether a worker process liveness endpoint is required by the deployment platform or whether process health plus DB heartbeats is sufficient.
- Admin-only notifications need an explicit follow-up threshold before adding external delivery channels.

## Handoff Notes

Implement state transitions and concurrency tests before the scheduler loop. Keep recovery based solely on committed database state so worker memory and process restarts never determine correctness.
