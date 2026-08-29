# Task: Prove Two Provider Imports in Parallel

**ID:** distributed-canonical-warehouse/021
**Depends on:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/022
**Blocks:** none at the current checkpoint
**Estimated scope:** large
**Estimated effort:** 4–7 days for one builder, including source adaptation, local provisioning, admin triggering, parallel-run proof, and verification
**Status:** not started

## Start Here

Use the supplied, protected ClutchPacks and Courtyard captures to write the
expected pack, collectible, pull, market-event, quarantine, cursor, and run
counts for each provider before connecting either source to the worker.

## Objective

Trigger one ClutchPacks run and one Courtyard run from the authoritative current admin UI,
ingest both through the source-neutral mixed-page boundary into separate
provider databases, and prove that the runs execute concurrently without
sharing leases, cursors, failures, or transactions.

## Context

The schema and generic provider-run machinery are useful only when a provider
integration supplies normalized mixed pages. ClutchPacks and Courtyard are the
first integration proof because reviewed mapping adapters and captured provider
feeds already exist for both. Captures are untrusted source data: they are
validated and mapped through the same boundary used by a future live fetcher.

This checkpoint proves local ingestion and orchestration. It does not activate
a Convex manifest, publish frontend data, or claim that a captured-feed reader
is a production live-source transport.

## Requirements

### Provider integrations

- Register explicit ClutchPacks and Courtyard source integrations by their
  provider and mapping identities; an unrelated or unknown adapter remains
  unavailable.
- Read captured input only from a server-owned, explicitly configured local
  root. Never accept a browser-selected path or persist/log the raw capture.
- Strictly validate each feed, use the existing reviewed ClutchPacks and
  Courtyard mapping behavior, pseudonymize provider actors, and translate the
  accepted output into `packscout.provider-mixed-page.v1` records.
- Produce deterministic, bounded pages, cursors, page IDs, record order, and
  response digests. Invalid record-local data is quarantined without advancing
  uncommitted work; invalid page-level identity fails without cursor movement.
- Persist packs, collectibles, pack contents when supported, pulls, and sale
  market events using the new provider canonical schema. Do not write the old
  canonical revision graph or introduce dual writes.

### Admin and worker execution

- Provision `packscout_clutchpacks` and `packscout_courtyard` with independent
  provider roles/connections and register both in central `packscout`.
- Run now succeeds only when the selected provider integration is installed;
  otherwise it returns `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` and creates no run.
- Start both runs from the current admin contract and let one worker process
  them with a concurrency of at least two.
- Keep one run, schedule, lease, cursor, and mixed counters per provider. There
  are no per-data-kind controls or shared provider transaction.

### Proof and safety

- Prove both runs overlap in time through a deterministic integration barrier or
  equivalent timing evidence, then reach independent terminal outcomes.
- Verify committed canonical counts and representative relationships directly
  in both provider databases, along with run/page/cursor/change evidence.
- Demonstrate that delaying or failing one provider does not prevent the other
  provider from committing and finishing.
- Keep the local review bootstrap repeatable and explicitly scoped; never reset
  existing databases or reveal credentials.

## User-Facing Behavior

The ported current admin lists ClutchPacks and Courtyard as separate providers. An operator can
select Run now on each, open each provider-qualified run detail, and watch mixed
catalog, pull, and market-event counters progress independently. A provider with
no installed integration receives a clear unavailable error and no empty run.

## Acceptance Criteria

### Ingestion acceptance

- [ ] ClutchPacks captured data commits through the new mixed-page boundary to
  `packscout_clutchpacks` with deterministic replay behavior.
- [ ] Courtyard captured data commits through the new mixed-page boundary to
  `packscout_courtyard` with deterministic replay behavior.
- [ ] Both providers contain representative packs, collectibles, pulls, sale
  market events, page summaries, promotion changes, and terminal run evidence.
- [ ] Raw captures, source credentials, database URLs, and unpseudonymized actor
  identifiers are absent from canonical rows, browser responses, and logs.

### Parallel and admin acceptance

- [ ] Admin Run now creates or reuses one run for each installed provider and
  rejects an uninstalled provider before mutation.
- [ ] A deterministic test proves the ClutchPacks and Courtyard source calls are
  simultaneously in flight and commit to separate provider databases.
- [ ] One provider delay or failure leaves the other provider runnable and able
  to finish.
- [ ] The admin starts against central plus routed provider databases without
  requiring the legacy combined operational database.

## Spec Compliance

- Implementation authority remains `tech-001-database-schema-contract.md` plus
  the explicit integration scope in this task.
- This task changes the prior provider-specific deferral only for ClutchPacks and
  Courtyard at the captured-feed proof boundary.
- No production live-source, Convex activation, migration, backfill, or legacy
  compatibility behavior is implied.
