# Task: Run ClutchPacks End to End First

**ID:** distributed-canonical-warehouse/023
**Depends on:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/022
**Blocks:** distributed-canonical-warehouse/021
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including source translation, provisioning, admin triggering, database verification, and preview proof
**Status:** done

## Start Here

Keep the verified ClutchPacks capture as deterministic mapping and replay
evidence alongside the completed authenticated DataForrest source-head proof.
Never persist or log a raw payload, bearer credential, or workstation-specific
path.

## Objective

Make ClutchPacks the first provider that an operator can trigger from the
authoritative current admin and ingest end to end into its isolated
`packscout_clutchpacks` database.

## Context

ClutchPacks is the smaller first dataset and has the strongest current provider
fact mapping. Proving one complete path before adding Courtyard reduces the
number of variables while the new admin, source seam, and provider database are
being integrated.

This task proves ingestion, not publication. No Convex release, manifest
activation, frontend cutover, or two-provider concurrency claim is made here.

## Source Evidence Constraint

The supplied capture contains 15 pulls and none includes a pack external ID.
Twelve include one shared series ID, but that series is also attached to 14
captured pack candidates, so it cannot identify a pack without fabrication.
The live DataForrest stream can also deliver valid pull and market facts before
their catalog rows, and it explicitly permits one side of a pull relationship
to be unreported.

The approved first-provider behavior is to store these facts immediately.
Immutable source keys distinguish `unreported` (source key is null) from
`unresolved` (source key is present while the local UUID is null). Later catalog
arrival may only resolve a null local UUID to the row matching that immutable
source key; it may never clear, relink, or rewrite the source fact. Every pull
retains at least one ordered item, including one null-key item when ClutchPacks
reports the pack but not the card. Only malformed source records are
quarantined. The importer must not create a synthetic catalog entity or choose
an unsupported relationship.

## Requirements

### ClutchPacks source integration

- Register explicit capture and live DataForrest ClutchPacks capabilities;
  unrelated adapter keys remain unavailable and cannot create a run.
- Read the capture only from a server-owned configured local root and enforce
  bounded file size, response shape, record count, deterministic ordering,
  page identity, cursor, and digest.
- Resolve the immutable DataForrest endpoint and encrypted source credential
  from the active central configuration at the server-owned worker boundary.
  Fetch bounded pages through the hardened production adapter until its opaque
  cursor reaches source head, then commit them only to `packscout_clutchpacks`.
- Validate the captured DataForrest response and reuse the active ClutchPacks
  observation/fact mapper before translating accepted records into
  `packscout.provider-mixed-page.v1` candidates.
- HMAC-pseudonymize actors before creating provider-account identities.
- Emit only relationships supported by source evidence. Do not invent pack
  contents or economics fields when the authoritative mapper cannot prove them.
- Preserve provider pack/card keys on facts independently of nullable resolved
  UUIDs. Store valid unreported and keyed-unresolved pull/event relationships,
  and reconcile keyed relationships in bounded batches when catalog rows arrive.
- Convert a record-local adapter or mapper rejection into one safe quarantine
  record so the rest of the authenticated source page can commit and advance.

### Database and admin path

- Provision `packscout_clutchpacks` with its own least-privilege role and
  credential and register its encrypted destination/configuration centrally.
- Apply and verify the provider schema without changing or resetting an
  existing database.
- Enable Run now only after the ClutchPacks capability is installed.
- Trigger the run through the authoritative Providers/Operations experience,
  using central authorization and a direct routed provider connection.
- Keep one ClutchPacks run, lease, cursor, schedule, page sequence, quarantine
  stream, and mixed counters.

### Proof

- Run an authenticated DataForrest import to source head and record API request
  count, fetched source records, normalized records, elapsed time, and bounded
  rate without retaining provider-native response bodies.
- Verify terminal run/page/cursor evidence and committed canonical counts
  directly in `packscout_clutchpacks`.
- Verify representative pack, collectible, pull, and sale-event relationships
  using public-safe identifiers, including the 15 card-only capture pulls with
  unreported pack relationships.
- Replay the same capture deterministically without duplicating immutable facts
  or advancing a false cursor/checkpoint.
- Prove raw payloads, source credentials, database URLs, and unpseudonymized
  actor identifiers are absent from rows, browser responses, audit, and logs.

## User-Facing Behavior

The current admin lists ClutchPacks as an independently configured provider. An
authorized operator selects Run now, opens the provider-qualified run detail,
and sees catalog, pull, market-event, page, quarantine, and terminal counters.
The UI remains unchanged from the authoritative admin baseline.

## Acceptance Criteria

- [x] `packscout_clutchpacks` is independently provisioned, migrated, registered,
  reachable, and visibly healthy without a legacy combined database.
- [x] Admin Run now creates or reuses one ClutchPacks run only after its source
  capability is installed.
- [x] The validated capture commits deterministic categories, packs,
  collectibles, accounts, 15 pulls with 15 items, market events, promotion
  changes, run pages, and cursor evidence with zero relationship quarantines.
- [x] The provider database verifies one deterministic page, 8 categories,
  14 packs, 907 collectibles, 17 pseudonymized accounts, 15 pulls/items, 15
  market events, and no synthetic pack or raw actor identity.
- [x] Identical capture replay is idempotent without duplicating facts,
  relationship resolutions, or promotion changes.
- [x] An uninstalled provider still fails before mutation with
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE`.
- [x] The authoritative admin route/UI parity guards and focused ClutchPacks
  source, repository, API, and browser tests pass.
- [x] The active ClutchPacks configuration references an encrypted central
  source credential and the live DataForrest capability.
- [x] Authenticated admin-triggered run
  `da9c58ff-2046-479c-84f4-0ff5f1f36695` used pinned configuration v4 and
  succeeded at source head in `packscout_clutchpacks`: 25 pages and 25
  successful API requests with zero failures processed 49,602 source records
  in 334.4 seconds (148.3 source records/second), without retaining raw payloads
  or exposing credentials.
- [x] The completed live run reported 6,730 catalog records, 22,362 pulls,
  20,510 events, 31,518 accepted records, 18,059 duplicates, 25 quarantines,
  and 31,518 material changes.
- [x] Final canonical verification reports 10 categories, 17 packs, 6,655
  collectibles, 17 pseudonymized accounts, 22,362 pulls with 22,362 ordered
  items, 20,525 market events, and 78,502 promotion changes, with every keyed
  unresolved relationship reconciled to zero.
- [x] Bounded historical reconciliation resolved 29,739 missing-reference
  quarantines. The 51 remaining historical pull records are explained and
  bounded: 30 are absent from both the current source and canonical data, and
  21 have immutable timestamp/digest mismatches. The live run's 25 new
  quarantines are immutable pull timestamp conflicts rather than missing
  catalog relationships.

## Spec Compliance

- Schema authority remains `tech-001-database-schema-contract.md` plus the
  current-admin ownership amendment in Task 022.
- ClutchPacks is a first-provider milestone inside the approved two-provider
  proof, not a new provider-specific branch in generic orchestration.
- Courtyard and concurrency remain Task 021; Convex publication remains paused.
- Configuration v4 is the exact immutable authority pinned to the completed
  run. It retains the approved adapter, source endpoint/settings, schedule,
  encrypted source-credential reference, and no-expiration policy independent
  of any later central active-pointer change.
- The provider schema change is additive. Pulls, pull items, and market events
  retain immutable provider source keys while their local catalog UUIDs may be
  deferred; later catalog arrival resolves only the matching null UUID and
  cannot rewrite, clear, or relink the source fact.
- Record-local defects quarantine independently, while keyed-unresolved facts
  remain canonical and are reconciled in bounded batches. The completed live
  run ended with zero keyed-unresolved relationships.
- Historical cleanup was bounded and evidence-driven: 29,739 legacy
  missing-reference quarantines were resolved without rewriting immutable
  source facts. The remaining 51 historical pulls and 25 new timestamp-conflict
  quarantines are explicitly classified above rather than treated as an open
  ingestion blocker.
- Completion evidence: admin-triggered run
  `da9c58ff-2046-479c-84f4-0ff5f1f36695`, configuration v4, terminal state
  `succeeded`, source head reached, 25 successful requests and zero failures,
  49,602 source records across 25 pages, and the final canonical totals recorded
  in the acceptance criteria.
- Related specs reviewed: `tech-001-database-schema-contract.md` and the Task
  022 current-admin ownership amendment.
- Alignment: implemented as specified, including exact run configuration
  authority, deferred source-key relationships, additive migration, bounded
  reconciliation, and admin-triggered provider-local execution.
- Divergences: none.
- Verification: authenticated admin-triggered source-head replay plus direct
  provider-database reconciliation and canonical-count verification.
