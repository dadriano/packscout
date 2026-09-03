# Feature: Distributed Hybrid Convex Promotion Jobs

## Start Here

Read `tech-001-distributed-promotion-jobs.md`, then use Task 009 for the live
cutover and certification of the completed distributed worker implementation.

**Progress:** 8/9 distributed tasks done. Tasks 001–008 are implemented and
verified. Task 009 remains the explicit live rollout/canary certification gate.

## Context

Each canonical provider database on Neon owns one independently invokable
provider-publication job. The job promotes complete immutable deltas into
Convex and never requires another provider database.

Provider completion is relayed asynchronously into the central `packscout`
database. One central manifest coordinator applies one provider gate at a time
with compare-and-swap, preserving every unrelated provider entry. Immediate
delivery improves latency; one-minute reconciliation, manual commands, and
durable continuation make delivery loss harmless.

The Admin app gains a read-only Promotion Jobs section with a dynamic provider
roster, central manifest state, scheduler liveness, publication progress,
partial-outage handling, and safe bounded history/detail.

## Approved Option A

- Provider publication state, wake, schedule, invocations, lease, exact requests,
  receipts, completed head, and completion outbox remain provider-local.
- Central owns the provider registry, completion inbox, per-provider gate
  intents, manifest operations, central job state, schedule observations,
  liveness conditions, evaluator, and alerts.
- No cross-database FK, join, lock, lease, cursor, or transaction.
- Internal authority uses `providerId`; the roster is dynamic and not capped
  by a hardcoded eight-provider launch list.
- Manifest operations are exactly `advance | add | remove | rollback`.
- A provider failure does not block another provider's publication or gate.
- Provider disablement does not implicitly remove public state.
- The legacy commits remain available on
  `codex/convex-promotion-jobs-pre-distributed` as algorithm/test port sources
  only.

## Tasks

### Distributed foundations

| ID | Task | Status | Depends on |
|---|---|---|---|
| 001 | Establish split durable promotion job records | done | distributed 013–015 schema contracts |
| 002 | Separate provider and central manifest authority | done | distributed 014, 015 |
| 003 | Run one provider publication job to head | done | 001, 002, distributed 014 |
| 004 | Reconcile one provider manifest gate centrally | done | 001, 002, distributed 015 |

### Triggering and liveness

| ID | Task | Status | Depends on |
|---|---|---|---|
| 005 | Trigger jobs immediately and reconcile on schedule | done | 003, 004, distributed 010 |
| 006 | Detect missed promotion jobs dynamically | done | 001, 005 |

### Admin and launch

| ID | Task | Status | Depends on |
|---|---|---|---|
| 007 | Expose distributed promotion job monitoring | done | 001, 006 |
| 008 | Monitor promotion jobs in Admin | done | 006, 007 |
| 009 | Cut over and certify distributed hybrid promotion | blocked | 005–008, distributed 017, 018 |

## Build Order

1. Restore and port distributed provider release assembly (Task 013).
2. Complete provider-local publication behind the current Convex contracts
   (Task 014).
3. Implement central one-provider manifest activation (Task 015).
4. Port the verified job ledger and authority model into split ownership
   (Tasks 001–002).
5. Port the bounded provider job and central manifest coordinator
   (Tasks 003–004).
6. Add the completion relay, hybrid delivery, schedules, and liveness
   (Tasks 005–006).
7. Add monitoring and Admin surfaces (Tasks 007–008).
8. Complete recovery/retention/isolation prerequisites and certify the clean
   authority cutover (Task 009), then hand its evidence to distributed Task 020.

## Dependency Graph

```text
distributed/013 -> distributed/014 -> 003
distributed/012 + distributed/014 -> distributed/015 -> 004
distributed/014 + distributed/015 -> 001 + 002
001 + 002 -> 003 + 004
003 + 004 + distributed/010 -> 005 -> 006 -> 007 -> 008
005 + 006 + 007 + 008 + distributed/017 + distributed/018 -> 009
009 -> distributed/020
```

## Verification Policy

Every task must run its declared focused checks, verify the acceptance criteria
against `tech-001-distributed-promotion-jobs.md`, and record any divergence.
The final exact commit must pass `npm run verify:framework`.

## Next Action

Complete distributed Tasks 017 and 018, then provision the preproduction
central/provider topology and publication credentials and run the live
two-provider canary and rollout evidence required by Task 009. Cold startup
intentionally fails closed without a current trusted bootstrap; a resident
worker continues from its last verified pin through a transient central outage.
