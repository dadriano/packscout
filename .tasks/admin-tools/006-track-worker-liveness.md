# Task: Track Worker Liveness

**ID:** admin-tools/006
**Depends on:** none
**Blocks:** admin-tools/007, admin-tools/009
**Estimated scope:** medium
**Status:** done

## Objective

Every pipeline worker instance durably reports its identity and liveness — when it started, that it's still alive, what it's doing, and how it stopped — so operators and alerting can tell a healthy fleet from a dead one.

## Context

The data pipeline runs as a separate long-lived worker runtime that claims scheduled provider work through database leases, heartbeats its active import runs, recomputes estimated EV, and enforces retention. Today the worker's existence is only visible indirectly: lease-owner strings and heartbeat timestamps on runs and schedule claims. If every worker process dies, nothing records that — imports silently stop and the admin can only infer trouble from growing staleness.

This task makes worker presence a first-class, durable fact. It is deliberately observer-side only: workers write their presence to the same durable store they already use for leases, and consumers (the admin in admin-tools/007, alerting in admin-tools/009) read it from there. The admin never connects to worker processes directly.

## Requirements

- Each worker instance registers a durable presence record on startup carrying: a stable instance identity, start time, a version/build identifier, and at minimum a host descriptor and runtime version (bounded — no secrets, no environment dumps).
- Alongside presence, each instance durably publishes the effective operating settings it is actually running with: heartbeat cadence, the presence-staleness threshold, the run-heartbeat staleness threshold (how stale a running import run's heartbeat may be before it counts as stalled), schedule-claim/lease durations, and retention windows. Consumers (admin-tools/007's fleet view, admin-tools/009's alerting) read these published values rather than keeping hard-coded copies.
- While running, the instance heartbeats its presence record at a bounded, configurable cadence, and the record reflects the instance's current activity at a coarse grain: idle, or working a specific provider/import run — consistent with the lease-owner identity it stamps on claims, so a stalled run can be traced to a named instance.
- A cleanly shutting-down instance marks its record stopped; an instance that vanishes (crash, kill, network partition) simply stops heartbeating, and consumers can classify it as stale/presumed-dead once its heartbeat age exceeds a defined threshold. That threshold is part of the published effective settings above, so consumers discover it rather than hard-coding it.
- Presence records are retained for a bounded recent window (enough to see recent restarts and crashes), and old records are pruned by extending the pipeline's existing retention machinery to cover them (the pipeline prunes protected raw payloads today; presence records become a new pruned kind).
- Heartbeat failures must not break pipeline work: a worker that cannot write its heartbeat continues its import work and retries presence reporting, and this degradation is observable in its structured logs.
- Multiple concurrent instances are supported and individually distinguishable; instance identity survives neither restarts nor redeploys (a restart is a new instance record referencing the same version or a newer one).

## User-Facing Behavior

None directly — this is worker-runtime instrumentation. Its effects surface in the admin fleet view (admin-tools/007) and worker alerts (admin-tools/009).

## Interface Contract

A worker-presence record readable by admin and alerting consumers with this logical shape:

- `instanceId` — stable for one process lifetime, matching the lease/claim owner identity that instance stamps on schedules and runs
- `version` — build/version descriptor
- `startedAt`, `lastHeartbeatAt` — timestamps
- `state` — running | stopped (stale/presumed-dead is derived by consumers from heartbeat age against the discoverable threshold)
- `currentActivity` — bounded descriptor: idle, or the provider/run being worked

Alongside presence, a published effective-settings surface (a companion durable record or equivalent readable projection) carrying: heartbeat cadence, presence-staleness threshold, run-heartbeat staleness threshold, lease durations, and retention windows.

admin-tools/007 renders presence records and settings, joining instances to runs/schedules via the owner identity. admin-tools/009 derives the fleet-silent condition from presence records; stalled runs are detected from import-run heartbeats (existing durable run data) against the published run-heartbeat staleness threshold, attributed to instances via the shared owner identity — presence records do not carry run-heartbeat data themselves.

## Acceptance Criteria

- [x] A starting worker creates a presence record; a running worker's heartbeat advances; a cleanly stopped worker is marked stopped; a killed worker's record goes stale by heartbeat age.
- [x] The instance identity on presence records matches the lease/claim owner identity that instance writes on schedule claims and import runs.
- [x] Two concurrent instances produce two distinguishable live records.
- [x] The published effective settings match the values the running instance actually uses, including the presence and run-heartbeat staleness thresholds.
- [x] A heartbeat write failure does not interrupt or fail import work.
- [x] Presence history is pruned to the bounded retention window.

## Verification

Worker runtime integration tests prove the lifecycle transitions (register → heartbeat advance → clean stop; kill → stale by age), concurrent-instance distinguishability, and identity consistency with lease owners. The worker package's test suite and the workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Presence is a durable `worker_instances` row per instance keyed by the same identity stamped as `provider_schedules.claim_owner` / `import_runs.lease_owner`, carrying state, activity, and the effective operating settings consumers read instead of hard-coding copies; pruning extends the existing protected-payload retention cycle as a new pruned kind.
- Divergences: The effective-settings surface is published as typed columns on the presence record rather than a separate companion table — the Interface Contract's "equivalent readable projection" — so settings can never be orphaned from the instance running them and pruning stays single-statement. `protectedPayloadRetentionDays` is not operator-configurable: it is sourced from the `PROTECTED_PAYLOAD_RETENTION_DAYS` invariant the ingestion repository enforces, so the published window provably equals the enforced one. Queue-claimed runs publish `scheduling` rather than `importing`, because that path resolves its run id inside the import service and the instance will not name a run it cannot yet identify.
- Verification: `npm run typecheck:database && npm run typecheck:services && npm run typecheck:worker && npm run test:database && npm run test:services && npm run test:worker && npm run check:prisma-only` — exit 0 (50 database, 161 services, 28 worker tests passing; prisma-only scanned 480 files). `npm run scan:framework-standards:ratchet` — 0 findings, 0 new. Also green: `npm run test:prisma-schema` (4), `npm run test:prisma-lifecycle` (4), `npm run test:contracts` (52), `npm run check:boundaries`, and lint for contracts/database/services/worker.
