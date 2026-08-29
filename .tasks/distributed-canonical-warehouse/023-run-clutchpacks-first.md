# Task: Run ClutchPacks End to End First

**ID:** distributed-canonical-warehouse/023
**Depends on:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/022
**Blocks:** distributed-canonical-warehouse/021
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including source translation, provisioning, admin triggering, database verification, and preview proof
**Status:** in progress

## Start Here

Write the expected ClutchPacks capture counts and representative pack,
collectible, pull, and sale relationships before enabling its source capability.
Use `/Users/lains/Documents/packscout-data/clutchpacks.json` as untrusted,
read-only local evidence; never persist or log the raw payload.

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
The active DataForrest observation mapper correctly preserves these as
card-only pulls; the new provider canonical schema currently requires every
pull to reference one pack.

The approved first-provider behavior is to quarantine all 15 pulls as
record-local evidence while continuing to commit the independent catalog and
market-event records. It must not create a synthetic pack, choose one of the 14
candidates, or weaken the canonical `pulls.pack_id` relationship. A later
source-evidence decision may retry those quarantines through the normal
recovery path.

## Requirements

### ClutchPacks source integration

- Register one explicit ClutchPacks source capability; unrelated adapter keys
  remain unavailable and cannot create a run.
- Read the capture only from a server-owned configured local root and enforce
  bounded file size, response shape, record count, deterministic ordering,
  page identity, cursor, and digest.
- Validate the captured DataForrest response and reuse the active ClutchPacks
  observation/fact mapper before translating accepted records into
  `packscout.provider-mixed-page.v1` candidates.
- HMAC-pseudonymize actors before creating provider-account identities.
- Emit only relationships supported by source evidence. Do not invent pack
  contents or economics fields when the authoritative mapper cannot prove them.

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

- Verify terminal run/page/cursor evidence and committed canonical counts
  directly in `packscout_clutchpacks`.
- Verify representative pack, collectible, and sale-event relationships using
  public-safe identifiers, plus the 15 quarantined pull records and their valid
  collectible-item evidence without asserting a pack relationship.
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

- [ ] `packscout_clutchpacks` is independently provisioned, migrated, registered,
  reachable, and visibly healthy without a legacy combined database.
- [ ] Admin Run now creates or reuses one ClutchPacks run only after its source
  capability is installed.
- [ ] The validated capture commits deterministic categories, packs,
  collectibles, accounts, market events, promotion changes, run pages, and
  cursor evidence while quarantining all 15 unresolved pulls with their valid
  collectible-item evidence.
- [ ] The provider database verifies five deterministic pages, 8 categories,
  14 packs, 907 collectibles, 17 pseudonymized accounts, 15 market events, and
  15 pull quarantines without any synthetic pack or raw actor identity.
- [ ] Identical replay is idempotent and invalid record-local evidence is safely
  quarantined.
- [ ] An uninstalled provider still fails before mutation with
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE`.
- [ ] The authoritative admin route/UI parity guards and focused ClutchPacks
  source, repository, API, and browser tests pass.

## Spec Compliance

- Schema authority remains `tech-001-database-schema-contract.md` plus the
  current-admin ownership amendment in Task 022.
- ClutchPacks is a first-provider milestone inside the approved two-provider
  proof, not a new provider-specific branch in generic orchestration.
- Courtyard and concurrency remain Task 021; Convex publication remains paused.
