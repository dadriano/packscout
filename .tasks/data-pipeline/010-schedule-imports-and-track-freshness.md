# Task: Schedule Imports and Track Freshness

**ID:** data-pipeline/010  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md)  
**Blocks:** [data-pipeline/011](011-manage-providers-in-admin.md), [data-pipeline/012](012-operate-imports-in-admin.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Write the timing example for an enabled provider with a five-minute schedule and fifteen-minute stale threshold across a success, an overlapping trigger, two failures, a stale transition, and a recovery.

## Objective

Every enabled provider runs on its configured cadence, survives process restarts without duplicate execution, and exposes freshness separately from unresolved data-quality problems.

## Context

Provider schedules are independently configurable and default to every five minutes. Stale thresholds are also configured per provider and default to fifteen minutes. A run may need several pages to finish a backfill or incremental catch-up, so a new trigger must not overlap an active run.

Freshness answers whether PackScout recently reached the provider head. Quality answers whether accepted pages left unresolved quarantine entries. A provider can therefore be fresh with warnings, stale without quarantines, or both stale and degraded.

## Requirements

### Scheduling and execution ownership

- Schedule every enabled provider from its immutable active configuration revision and configured interval, defaulting to five minutes.
- Persist next-due and execution ownership so restarts, multiple runtime instances, and delayed workers do not create overlapping runs for one provider.
- Coalesce a scheduled trigger that occurs during an active run and record the skipped or deferred outcome without treating it as an import failure.
- Use the same run workflow for scheduled and manual imports; scheduling adds no separate fetch, mapping, cursor, or projection path.
- Define freshness from the latest run that reached an accepted `has_more: false` provider head. Compare its completion time with the provider's stale threshold, defaulting to fifteen minutes.

### Health, recovery, and lifecycle

- Track quality separately using open quarantine counts, latest incomplete run, and latest mapping or calculation warnings.
- Expose provider health containing schedule interval, stale threshold, next due time, active run reference, last attempted time, last head-reached time, freshness state, quality state, consecutive failure count, and latest bounded failure class.
- Reset consecutive failure state only after a run reaches the provider head. Resolve stale state immediately after that recovery without erasing historical failures.
- Stop creating scheduled runs for disabled or archived configurations. Permit their already-active immutable-revision run to finish.
- Bound catch-up behavior after downtime so missed intervals coalesce into one current run rather than a burst of historical triggers.

## User-Facing Behavior

Operators later see `fresh` or `stale` independently from `healthy`, `warning`, or `degraded` data quality. The status includes last attempt, last successful provider-head time, next run, active run, schedule, stale threshold, consecutive failures, and a concise recovery hint.

## Interface Contract

The scheduler consumes enabled configuration revisions and a current time and claims due work through durable execution ownership. It requests a scheduled run from the shared run service and records `started`, `coalesced`, or `not_enabled` without calling adapters directly.

The health projection returns provider identity, timing configuration, `freshness_state`, `quality_state`, active and latest run references, last attempted and head-reached timestamps, next due timestamp, open quarantine count, consecutive failures, latest failure class, and recovered-at time.

## Acceptance Criteria

- [ ] Five-minute default and custom schedule fixtures start due runs exactly once across restart and multi-worker contention.
- [ ] Active-run triggers coalesce, downtime produces one catch-up run, and manual plus scheduled triggers never overlap or diverge in ingestion behavior.
- [ ] Custom stale thresholds transition from fresh to stale based on provider-head completion, then recover on the next head-reaching run.
- [ ] Freshness and quality remain independent when a run reaches the head with quarantines, when failures occur without quarantines, and when old quarantines are later resolved.
- [ ] Disabled and archived configurations stop future scheduling while an already-active revision-bound run can finish safely.
