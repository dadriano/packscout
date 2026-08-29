# Task: Keep Provider Execution State Local

**ID:** distributed-canonical-warehouse/005
**Depends on:** distributed-canonical-warehouse/003, distributed-canonical-warehouse/004
**Blocks:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/009, distributed-canonical-warehouse/010, distributed-canonical-warehouse/018
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including state recovery, lease fencing, command audit, and retention behavior
**Status:** in progress

## Start Here

Write the provider-local state machine for runtime, worker ownership, runs, commands, quarantine, and promotion checkpoints, with one transition table showing which actor may perform each transition.

## Objective

Make each provider database authoritative for its own execution state so a provider can continue, pause, recover, and publish independently of central observation or another provider's health.

## Context

Runner processes are centrally deployed, but their durable state is distributed. One provider database owns one runtime, one schedule, one source cursor, one import worker lease, one active run, and its promotion coordination. The central database stores configuration and observations; it does not become the execution lock or checkpoint authority.

This model replaces platform streams and stream controls. Catalog, pull, and market-event records are data kinds inside one provider response, not independently manageable streams.

## Requirements

### Runtime state

- Store one `PROVIDER_RUNTIME` row with the central provider soft reference, cached configuration version, nullable configuration expiration, operating state, state reason, one schedule, one durable cursor, health counters, timestamps, and row version.
- Use operating states `idle`, `running`, `paused`, `stopped`, and `error`; require a bounded reason for `paused`, `stopped`, and `error`.
- Record every runtime transition in append-only `PROVIDER_STATE_EVENTS` with prior state, next state, reason, actor type, actor soft ID, correlation ID, and occurrence time.
- Treat a null configuration expiration as no expiration; accept only a centrally authorized sync with matching provider identity and a newer version, expose version mismatch, and let an expired cache block new work after active work terminates.
- Permit work that already holds valid local authority to continue when central observation is unavailable.

### Worker and run coordination

- Store provider-level `PROVIDER_WORKER_STATES` with one internal `import` row and one internal `promotion` row, each carrying owner, monotonic fence, heartbeat, and expiration; stale owners cannot commit.
- Store provider-level `PROVIDER_RUNS` with `queued | running | succeeded | incomplete | failed` state, trigger, requester soft reference, config version, cursor bounds, counters, safe failure, heartbeat, and immutable terminal outcome.
- Store `PROVIDER_RUN_PAGES` with ordered page number, one requested cursor, one next cursor, mixed record counts, bounded digest, and committed time.
- Enforce at most one queued or running import run per provider and reuse the active run for an idempotent duplicate request.
- Keep promotion leases, fences, confirmed change checkpoints, append-only publication operations and receipts, and recovery state local without exposing them as admin-visible ingestion streams.

### Commands and audit

- Store provider-wide `CONTROL_COMMANDS` for run, pause, resume, stop, and retry actions with idempotency key, expected generation, requester soft reference, correlation ID, reason, status, and bounded result.
- Acknowledge a command only after the provider database accepts or rejects it under its current generation.
- Store append-only `LOCAL_AUDIT_EVENTS` for command, state, run, quarantine, retention, and promotion actions.
- Use the same correlation ID in central admin audit and provider-local command or audit records without requiring a distributed transaction.
- Do not create a durable central offline command queue; an unreachable provider returns an explicit failure for operator mitigation.

### Recovery and retention

- Store `QUARANTINE_RECORDS` and append-only `QUARANTINE_ATTEMPTS` with safe evidence lifetime, state, retry count, and independent outcomes.
- Store `RETENTION_EXECUTIONS` with policy, cutoff, counters, safe failure, and terminal outcome.
- Recover expired worker ownership from the last committed provider cursor and leave uncertain work unable to advance that cursor.
- Keep historical run outcomes immutable; retrying quarantine or recovering an incomplete run creates separate evidence.
- Preserve local execution and audit history needed to reconcile active, previous, in-flight, and retryable publication state.

## User-Facing Behavior

Operators manage one provider runtime rather than three data streams. Pausing, stopping, resuming, or running a provider affects the single mixed-response workflow. An emergency stop appears as `stopped` with its reason. Central unavailability does not falsely reset local state, and an unreachable provider reports an explicit error instead of accepting an offline command.

## Interface Contract

A provider runtime snapshot contains provider ID, operating state and reason, state generation, cached configuration version and expiration, schedule, safe cursor fingerprint, active and latest run IDs, lease status, freshness, quality, failure summary, and observation time.

A provider command contains `commandId`, `idempotencyKey`, `commandType`, `expectedGeneration`, requester soft ID, correlation ID, reason, and request time. Its result is `accepted`, `deduplicated`, `conflict`, `forbidden`, or `failed` with a stable safe code.

## Acceptance Criteria

### Authority acceptance

- [ ] Provider runtime, cursor, schedule, worker fence, runs, commands, quarantine, retention, local audit, and promotion checkpoints are provider-local.
- [ ] No stream, stream-key, per-data-kind cursor, per-data-kind schedule, or per-data-kind worker state exists.
- [ ] Runtime transition history records state, reason, actor, generation, and correlation without rewriting older events.
- [ ] A stopped provider records the emergency or operator reason through the general state model.
- [ ] Central observation loss does not overwrite or reset valid local authority.

### Recovery acceptance

- [ ] Duplicate run or command requests return the existing active outcome without creating concurrent provider work.
- [ ] A stale or expired lease owner cannot commit a page, cursor, command result, or promotion checkpoint.
- [ ] Restart recovery begins from the last committed cursor and retains immutable historical outcomes.
- [ ] An unreachable provider returns a bounded failure and never creates a central queued command.
- [ ] Two provider runtimes can hold independent leases and progress concurrently without shared execution state.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- One provider owns one runtime, cursor, schedule, import lease, and active mixed run; no stream authority is introduced.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
