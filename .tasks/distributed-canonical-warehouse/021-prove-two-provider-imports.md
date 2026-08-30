# Task: Prove Two Provider Imports in Parallel

**ID:** distributed-canonical-warehouse/021
**Depends on:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/022, distributed-canonical-warehouse/023
**Blocks:** none at the current checkpoint
**Estimated scope:** large
**Estimated effort:** 2–4 additional days after ClutchPacks, including Courtyard adaptation, local provisioning, parallel-run proof, and verification
**Status:** in progress

## Current Execution Slice

Provision and register the three remaining DataForrest launch providers—
Courtyard, Collector Crypt, and Phygitals—alongside the completed ClutchPacks
provider. Run Courtyard first. Collector Crypt and Phygitals must remain
reachable, empty, and idle until their own live source admission is proven. The
operator later expanded the checkpoint to activate and import both providers
after that exact proof, with provider-scoped credentials and closed capability
registration. This slice must include a deterministic simultaneous
ClutchPacks/Courtyard runner barrier proving that provider lanes share no
execution lock. Courtyard remains the first live DataForrest run; the other two
launch providers follow independently without changing the runner architecture.
Courtyard is pinned to 100 records per request and the fixed 8 MiB response
ceiling: read-only live censuses proved that a later 500-record response and,
after 1,600,000 records, a 250-record response can breach that ceiling. Neither
larger request size is an accepted operating profile. A 100-record census then
reached 1,220,000 source records without breaching the bound before the operator
prioritized the real queued import. The terminal import counters, not an
additional duplicate source scan, now become the frozen verification baseline.

The four local provider databases now resolve through the real central gateway.
The live lanes use the generic provider entrypoint; the retained Task 023
standalone local entrypoint still takes a provider URL and is not used here.
Its retirement remains follow-up work after equivalent generic-runner proof
coverage; this checkpoint does not claim every historical utility is ported.
Collector Crypt and Phygitals began active with database-only activation
attestations, but no source credentials or installed execution capability.
Their generation-zero state is the pre-activation baseline, not permission to
fabricate an empty successful run. The local multi-lane runner admits only installed provider
tuples, uses one central bootstrap per lane, and retains that exact authorized
route and source authority in memory for provider-local continuity.

### Live checkpoint evidence — 2026-08-29

- Admin Canonical Data lists all four providers, routes per-provider reads, and
  shows the completed ClutchPacks census: 17 packs, 6,655 collectibles, 22,362
  pulls, and 20,525 market events. Pack-row expansion renders real canonical
  JSON without a legacy combined-schema read.
- Courtyard's first live run exposed a per-page lease-release defect. The
  bounded executor now retains a live same-owner fence only for page progress;
  terminal outcomes release it. A real PostgreSQL regression proves two pages
  keep one run/fence, a competing worker is contended, and terminal success
  releases the lease. The 72 pre-fix recovery attempts remain in history;
  post-fix run `a3f0b43c-0af5-4d40-8563-b92b12a15f37` remains continuous on
  attempt/fence 73. The `2026-08-30T01:45:48Z` aggregate checkpoint has
  464,800 committed records (4,648 pages, including 4,576 in the continuous
  run): 392,847 pulls and 71,953 market events, with zero duplicates/quarantine.
  Source-head completion is still pending; the observed feed exceeds 1.6 million
  records, which is a lower bound, not an exact total.
- Collector Crypt's bounded live source probe returned HTTP 200 with one
  validated record; config v2 and a distinct encrypted source credential were
  activated atomically. Run `fe6ea7ea-dce6-42ba-bba6-e493921f96b9` is continuous
  on attempt/fence 1. Its audited `2026-08-30T01:45:48Z` checkpoint contains
  407,400 committed records: 113,027 market events and 294,373 pulls with
  matching pull items, zero duplicates, and zero quarantines. Catalog rows have
  not appeared yet. Near-simultaneous Courtyard/Collector heartbeats and
  independent cursor/run/database commits prove live overlap.
- Phygitals passed transport and database gates but its first 133 pages all
  failed record mapping: native card names are nested at `data.chase.name`,
  while the shared launch-v1 reader expected top-level `provider_label`. Run
  `b3f721f8-37fb-4961-8756-ee11819a66ec` is honestly incomplete with 13,300
  preserved expired quarantines and zero canonical changes. A new immutable
  Phygitals-only adapter admitted the observed `chase.name` and `asset.name`
  wrappers under config v3. Its retained run
  `d5f84568-9a2c-4fdc-a11f-b5858e97e278` processed 15,100 records: 741 accepted
  changes, 12,567 duplicates, and 1,792 new quarantines before it was stopped
  and its exact lease released. Config v4
  `e3e31fff-115f-59df-bdf4-a8975c6ab1b5` pins the new immutable
  `dataforrest-phygitals-distributed-adapter-v2`, adding observed
  `inventory.title` and `nft.name` wrappers while preserving the prior reader.
  Four fresh 100-record live admission probes passed before activation; the
  guarded origin replay verifies the exact previous run, cursor hash, fence,
  canonical identities/row versions, and retained quarantine history.
- Phygitals v4 run `557652e2-1fd8-4b5f-9965-52061bc661ef` is independently
  running on fence 5. At `2026-08-30T01:45:07Z`, 474 committed pages contained
  47,400 source records: 45,530 accepted new cards, 742 duplicates, and 1,128
  new quarantines. The total 46,271 stored cards includes all 741 prior cards,
  whose IDs, source keys, and row versions remain unchanged. All 15,092 older
  quarantines and both incomplete run histories are preserved.
- The first 151 Phygitals v4 pages produced zero new quarantines. Its first
  100 pages inserted 9,271 distinct canonical identities that match the
  original v2 quarantines: v3 counted repeated quarantines as duplicates, not
  as existing canonical cards. Sampled later rejects contain only
  `data.reveal`, without a reviewed card-name wrapper, and remain quarantined
  rather than receiving invented names. No fully quarantined v4 page appeared
  in the 474-page census. Source-head completion remains pending; transport
  success alone is not ingestion acceptance.
- Source-authority expiry or cancellation after a committed page now
  terminalizes only the exact owned running run/fence and releases its lease;
  tests reject stale cleanup against a successor. Progress never starts an
  extra source request merely to clean up, and the 50,000-page hard boundary
  remains enforced.
- `npm run verify:framework` passed end to end on 2026-08-29. The worker
  suite passed 231 tests with 17 protected/environment-gated cases skipped;
  focused disposable PostgreSQL proofs were also executed for parallel
  provider isolation, continuous page leases, and exact-owner cleanup. The
  Phygitals admission/reader checks and eight guarded v4 replay tests passed.
  No live ClutchPacks queued command was consumed for these checks.

## Start Here

Begin from the completed ClutchPacks proof in Task 023. Preserve the
already-proven ClutchPacks path while Courtyard establishes its first exact
pack, collectible, pull, market-event, quarantine, cursor, and run counts at
source head; freeze those terminal counts before replay or promotion.

## Objective

Trigger the proven ClutchPacks integration and one Courtyard run from the authoritative current admin UI,
ingest both through the source-neutral mixed-page boundary into separate
provider databases, and prove that the runs execute concurrently without
sharing leases, cursors, failures, or transactions.

## Context

The schema and generic provider-run machinery are useful only when a provider
integration supplies normalized mixed pages. ClutchPacks and Courtyard are the
first integration proof because reviewed mapping adapters and live DataForrest
feeds exist for both. Source responses are untrusted data: they are strictly
validated and mapped through the source-neutral mixed-page boundary.

ClutchPacks is proven alone first. This checkpoint then proves local
two-provider ingestion and orchestration. The operator subsequently approved a
local-only Convex manifest/frontend proof for the frozen ClutchPacks snapshot
and live-source activation of the two remaining launch providers. None of this
claims a production deployment.

## Requirements

### Provider integrations

- Register explicit ClutchPacks and Courtyard source integrations by their
  provider and mapping identities; an unrelated or unknown adapter remains
  unavailable.
- Preserve the completed ClutchPacks counts, mappings, and replay behavior from
  Task 023 while adding Courtyard; the two capabilities are independently
  enabled and never share an all-or-nothing switch.
- Resolve source configuration and encrypted provider-scoped credentials from
  central `packscout`. Never accept browser-supplied source authority or
  persist/log raw source responses or credentials.
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
- Provision `packscout_collector_crypt` and `packscout_phygitals` with their own
  provider roles/connections and register all four launch providers in central
  `packscout`; do not start either import before its exact live source check,
  scoped credential/configuration revision, and capability activation succeed.
- Store every provider database locator and encrypted database credential in
  central `packscout`. Admin and runners resolve a provider connection by
  provider ID; no provider database URL or password is persisted in process
  environment configuration.
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

After the standalone ClutchPacks milestone, the ported current admin lists
ClutchPacks and Courtyard as separate providers. An operator can
select Run now on each, open each provider-qualified run detail, and watch mixed
catalog, pull, and market-event counters progress independently. A provider with
no installed integration receives a clear unavailable error and no empty run.

## Acceptance Criteria

### Ingestion acceptance

- [x] ClutchPacks live source data commits through the new mixed-page boundary to
  `packscout_clutchpacks` with deterministic replay behavior.
- [ ] Courtyard live source data commits through the new mixed-page boundary to
  `packscout_courtyard` with deterministic replay behavior.
- [ ] Both providers contain representative packs, collectibles, pulls, sale
  market events, page summaries, promotion changes, and terminal run evidence.
- [ ] Raw captures, source credentials, database URLs, and unpseudonymized actor
  identifiers are absent from canonical rows, browser responses, and logs.

### Parallel and admin acceptance

- [x] Courtyard, Collector Crypt, and Phygitals are independently provisioned,
  centrally registered, reachable, and visible in the authoritative admin.
- [ ] Collector Crypt and Phygitals remain mutation-free until their own exact
  live source-admission proof, scoped credential/configuration revision, and
  installed capability succeed; each import then records honest terminal
  counters in its isolated database.
- [ ] Admin Run now creates or reuses one run for each installed provider and
  rejects an uninstalled provider before mutation.
- [x] A deterministic test proves the ClutchPacks and Courtyard source calls are
  simultaneously in flight and commit to separate provider databases.
- [x] One provider delay or failure leaves the other provider runnable and able
  to finish.
- [ ] The admin starts against central plus routed provider databases without
  requiring the legacy combined operational database.

## Spec Compliance

- Implementation authority remains `tech-001-database-schema-contract.md` plus
  the explicit integration scope in this task.
- This task changes the prior provider-specific deferral for the four approved
  DataForrest launch providers at the bounded live-source proof boundary.
- No production deployment, migration, backfill, or legacy compatibility
  behavior is implied. Convex publication in this checkpoint is local-only and
  uses the stable ClutchPacks provider snapshot.
