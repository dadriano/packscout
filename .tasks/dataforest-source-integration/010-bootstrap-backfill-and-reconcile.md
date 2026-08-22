# Task: Bootstrap, Backfill, and Reconcile

**ID:** dataforest-source-integration/010
**Depends on:** dataforest-source-integration/008, dataforest-source-integration/009
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder plus the live full-history backfill
**Status:** blocked

## Start Here

Provision a new empty local PostgreSQL target, record its exact identity and available capacity, run the completed schema migrations, and confirm that no existing populated database will be modified.

## Objective

Bootstrap the first local DataForrest environment, run all four real historical imports concurrently, prove restart and incremental behavior, reconcile every delivered record, and record a practical completion scorecard.

## Context

This is a first development pass, not a production cutover. A new empty local database avoids destructive migration ceremony and leaves any incompatible populated database untouched. The DataForrest credential enters the new environment once through task 004's encrypted administrator workflow.

The announced 14.5-million-record total is dated plausibility context, not an exact per-provider gate. Completion is based on actual page and disposition reconciliation at each provider's reached-head checkpoint plus successful operational and repository verification.

## Requirements

### Local bootstrap

- Use an explicitly identified empty local database and reject preproduction, live, broad, or unexpectedly populated targets.
- Verify available capacity meets task 006's approved full-history and index forecast plus the seven-day raw, 30-day quarantine, 30-day diagnostic, 30-day terminal request-attempt, and permanent compact attempt-lineage budgets before starting imports.
- Apply the forward schema and runtime replacement with no compatibility path to an old aggregate provider model.
- Run a target-scoped local bootstrap that idempotently creates one organization and first administrator in that exact migrated database without opening a separate disposable database or deleting existing data.
- Configure the same database and credential-encryption key version for admin and worker, then create one shared profile and four paused sources, enter the bearer through the encrypted workflow, unset the evidence-only local token before the supervisor starts, and verify no plaintext credential enters process output or worker configuration.

### Executable local runbook

- Deliver exact copyable commands for dependency setup, schema validation, migration deployment, parity checks, and target identity verification against the named empty local database.
- Deliver exact commands for the organization and first-administrator bootstrap, including required ignored-environment inputs and safe generation or delivery of session, credential-encryption, actor-pseudonym, and key-version values.
- Deliver exact commands to start the admin and singleton worker against the same database, identify the URLs or status endpoints, and stop or restart them safely.
- Document the exact admin or supported command flow to create the shared profile, enter the bearer, run connection and source tests, activate and resume four sources, Run now, change an interval, pause or resume, and open each diagnostic feed.
- Keep database URLs, passwords, bearer tokens, and key bytes out of command arguments, output, screenshots, shell history, and committed examples; use placeholders only where an operator supplies ignored secret state.

### Real backfill

- Start the actual local supervisor and resume all four platform processors so different providers overlap within the approved execution and request limits.
- Continue each provider from null through bounded runs until the DataForrest adapter commits `poll_after(60)` and its independent schedule becomes incremental.
- Force one supervisor interruption after committed pages while multiple providers are active and prove every lane recovers from its own last committed checkpoint.
- Exercise one provider-local retry or pause without delaying another provider and verify each source's diagnostic feed records only its events plus labeled shared events.
- Do not use a synthetic 14.5-million-record harness as proof of actual DataForrest correctness or performance.

### Incremental and manual proof

- Observe every reached-head provider across at least one configured due window and prove no early upstream poll occurs.
- Run one immediate manual import while scheduled work is pending or running and prove the result coalesces without a duplicate run or checkpoint.
- Change one provider's interval without changing another provider's next due time, checkpoint, health, or diagnostic feed.
- Pause and resume one provider at a committed page boundary and prove the other three continue.
- Verify exact replay is duplicate and a later valid catalog availability revision restores the approved canonical and fixture-projected public behavior.

### Reconciliation and capacity

- Reconcile every received page record for each provider to exactly one inserted, revised, duplicate, or quarantined disposition.
- Reconcile canonical packs, catalog assets, pulls, market events, relationships, EV inputs, EV recomputation outcomes, and current availability to their source dispositions.
- Require zero unresolved malformed records, platform mismatches, broken identities, immutable conflicts, or relationship failures before feature completion.
- Record actual provider pages, records, bytes, elapsed time, throughput, retries, head time, incremental latency, memory peak, and database relation and index sizes.
- Abort safely before exhausting approved local capacity, preserve committed checkpoints, and return the storage forecast for plan revision if measured growth breaches the preflight.

### Admin and final verification

- Verify the admin overview shows four honest concurrent processor states, capacity, progress, wait reasons, controls, health, quarantine, and no-live-worker behavior.
- Verify each provider detail shows safe checkpoint fingerprints, run and page history, and an isolated 30-day diagnostic feed with useful failure and recovery events.
- Verify public contract and UI fixture behavior for available, unavailable, unknown, sold-out, disappearance, and reappearance without exposing ingestion internals or claiming live publication.
- Run the focused contract, database, service, worker, admin, public, and browser checks mapped by the feature scenarios.
- Run `npm run verify:framework` without bypassing, weakening, or baselining a new finding.

### Source-abstraction sign-off

- Run the test-only alternate-adapter harness after production composition checks and record that it is absent from production and admin registries.
- Prove source type and mapper resolve from separate immutable pins, opaque checkpoints resume without parsing or transfer, and normalized continuation drives generic scheduling.
- Prove a compatible alternate Courtyard source preserves canonical identity only with the same record-ID scopes and replacement identity namespace while retaining distinct source lineage and leaving the other three providers unchanged.
- Prove semantic observation replay adds a delivery occurrence without duplicating semantic, canonical, or EV state, while every delivery remains traceable.
- Prove an identity-namespace or record-ID-scope mismatch blocks activation and no ID bridge, checkpoint converter, dynamic plugin, or dual-source cutover was added.

## User-Facing Behavior

Administrators see all four providers progress from paused through catch-up to reached head, with independent logs and controls. A source-local failure remains visibly local while the others continue; a shared connection failure appears once and gives only its bound sources an explicit wait reason. The live public catalog remains blocked on the separate publisher and finalizer; this task proves only its availability contract and UI readiness.

## Interface Contract

This task produces one dated local completion scorecard containing:

| Evidence | Required result |
|---|---|
| Environment | Exact local database identity, initial capacity, schema, organization, administrator, shared runtime key revision, DataForrest source type and profile, and four source and mapper revisions |
| Provider results | Terminal checkpoint fingerprint, head time, pages, source records, dispositions, canonical and EV counts, quarantine, and PASS or BLOCKED |
| Runtime | Parallel-overlap, fairness, restart, pause, manual coalescing, independent intervals, and diagnostic evidence |
| Resources | Actual duration, throughput, memory peak, relation and index sizes, retention forecast, and remaining capacity |
| Runbook | Exact secret-safe bootstrap, admin, worker, import, monitoring, pause, restart, and verification commands |
| Verification | Scenario evidence, focused commands, browser checks, and canonical repository gate result |

A provider may remain operationally isolated in BLOCKED state, but this feature is complete only when all four providers are PASS and have reached head with zero unresolved reconciliation failures.

## Acceptance Criteria

### Data and runtime proof

- [ ] One target-scoped bootstrap creates the local organization and first administrator in the named migrated database, shares the approved key revision with admin and worker, and never touches another database.
- [ ] The environment contains one encrypted shared profile and exactly four approved source instances with no obsolete runtime path.
- [ ] All four real backfills reach head, overlap where capacity permits, recover from interruption, and return to independent incremental schedules.
- [ ] Every delivered record and canonical or EV outcome reconciles exactly, with zero unresolved launch-blocking quality failures.
- [ ] Manual, pause/resume, retry, source-failure isolation, shared-connection wait, interval-change, replay, and availability transitions preserve the correct source or profile scope.

### Operations and completion proof

- [ ] Admin progress, controls, health, quarantine, supervisor capacity, no-worker state, and isolated processor log feeds match durable runtime evidence.
- [ ] Actual storage, memory, throughput, duration, and incremental latency remain within the approved local capacity plan or stop safely before exhaustion.
- [ ] Public availability contract and UI readiness pass while live publication remains explicitly blocked on the separate publisher and finalizer, with no ingestion-specific certification ledger.
- [ ] The executable local runbook reproduces bootstrap, admin, worker, manual import, monitoring, pause or resume, restart, and verification without placing secrets in commands or output.
- [ ] Every scenario has automated evidence or an owner-approved manual gap, and `npm run verify:framework` passes without a bypass or new baseline.

### Abstraction proof

- [ ] Production completion uses only `dataforrest-events-v1`, while the test-only alternate adapter proves the generic source, mapper, importer, scheduler, checkpoint, capacity, and admin boundaries.
- [ ] The final dependency check finds no DataForrest transport type or field in generic lifecycle, scheduling, import, persistence, mapper-selection, or admin-domain contracts.
- [ ] Replacement preserves stable canonical identity only under the same record-ID scopes and replacement identity namespace and always starts a distinct source checkpoint at null.
- [ ] Semantic observations deduplicate independently of per-delivery occurrences, and all occurrence lineage reconciles to exactly one disposition.

## Verification

- `node --test scripts/local/provider-source-task010-safety.test.mjs` — PASS,
  12/12 focused safety, target, bootstrap-receipt, topology, secret-redaction,
  and reconciliation tests.
- `npm run verify:framework` — PASS on 2026-08-21, including Prisma validation
  and migration tests, zero framework-ratchet findings, lint, typecheck, all
  workspace tests, tooling, and frontend/admin production builds.
- `npm run check:docs`, `npm run check:scripts`, `npm run check:boundaries`, and
  `git diff --check` — PASS.
- The read-only capacity preflight rejects this host with 30,338,781,184 bytes
  available versus 8,757,364,735,856 required, plus the 80%-used and projected
  threshold fences. No database, credential, admin process, supervisor, or live
  backfill was started.

## Spec Compliance

- The target-bound initializer, inspection, guarded migration, idempotent
  bootstrap, configuration-only supervisor, capacity-gated backfill start,
  reconciliation report, executable runbook, and dated BLOCKED scorecard are
  implemented and fail closed.
- Live acceptance remains intentionally unchecked: the exact database target,
  encrypted credential delivery, four real histories, operational/browser
  exercises, resource measurements, and final reconciliation require an
  approved backing volume and authorized DataForrest bearer.
- The production canonical-to-public publisher/finalizer remains a separate
  prerequisite; this task does not claim live public publication.
