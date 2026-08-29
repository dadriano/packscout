# Task: Run ClutchPacks End to End First

**ID:** distributed-canonical-warehouse/023
**Depends on:** distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/022
**Blocks:** distributed-canonical-warehouse/021
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including source translation, provisioning, admin triggering, database verification, and preview proof
**Status:** in progress

## Start Here

Keep the verified ClutchPacks capture as deterministic mapping and replay
evidence, then prove the same provider through the authenticated DataForrest
API. Never persist or log a raw payload, bearer credential, or
workstation-specific path.

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

- [x] `packscout_clutchpacks` is independently provisioned, migrated, registered,
  reachable, and visibly healthy without a legacy combined database.
- [x] Admin Run now creates or reuses one ClutchPacks run only after its source
  capability is installed.
- [x] The validated capture commits deterministic categories, packs,
  collectibles, accounts, market events, promotion changes, run pages, and
  cursor evidence while quarantining all 15 unresolved pulls with their valid
  collectible-item evidence.
- [x] The provider database verifies one deterministic page, 8 categories,
  14 packs, 907 collectibles, 17 pseudonymized accounts, 15 market events, and
  15 pull quarantines without any synthetic pack or raw actor identity.
- [x] Identical capture replay is idempotent and its invalid record-local
  evidence is safely quarantined.
- [x] An uninstalled provider still fails before mutation with
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE`.
- [x] The authoritative admin route/UI parity guards and focused ClutchPacks
  source, repository, API, and browser tests pass.
- [x] The active ClutchPacks configuration references an encrypted central
  source credential and the live DataForrest capability.
- [ ] An authenticated admin-triggered DataForrest run reaches source head in
  `packscout_clutchpacks`, with request/page/rate evidence and no raw payload or
  credential leakage.

## Spec Compliance

- Schema authority remains `tech-001-database-schema-contract.md` plus the
  current-admin ownership amendment in Task 022.
- ClutchPacks is a first-provider milestone inside the approved two-provider
  proof, not a new provider-specific branch in generic orchestration.
- Courtyard and concurrency remain Task 021; Convex publication remains paused.
- Capture checkpoint completed on 2026-08-29: the authoritative admin queued the
  initial run and an identical replay through the provider-routed command path.
  The approved 2,000-record page limit and 4,000-record / 8 MiB normalized
  envelope emitted all 976 captured records as one 960,893-byte head page. The
  replay finished in 1,610 ms at 606.21 records/second with 961 duplicates, 15
  quarantines, and zero material changes; canonical and promotion counts did
  not grow. The focused mixed-page, worker, disposable PostgreSQL, admin API/UI,
  typecheck, and lint checks pass.
  The replay rate is not compared directly with the initial write rate because
  duplicate validation performs less database work than first-time ingestion.
  The repository-wide verifier remains blocked by pre-existing EV-cutover
  inventory drift in generated Prisma output and the central worker presence
  repository; none of the reported files are changed by this task.
- Live API amendment: the user clarified that the first-provider checkpoint is
  incomplete until it fetches DataForrest directly. The supplied API contract
  describes one cursor-driven mixed endpoint, at-least-once delivery, an opaque
  cursor bound to the platform filter, a 5,000-record API maximum, and an
  estimated 39,746 ClutchPacks records / 54 MB. The credential from that
  contract was used ephemerally on 2026-08-29, passed a bounded one-record live
  check, and was encrypted as central source credential v1. The initial generic
  active config v2 was then non-destructively upgraded to the dedicated
  ClutchPacks adapter in active config v3 while reusing that encrypted
  credential. The plaintext credential is not stored in `.env`, task artifacts,
  logs, or provider-local rows.
- The direct distributed bridge, sanitized request/page metrics, and distinct
  2,000-source-record ClutchPacks request profile are implemented without
  changing the shared 500-record adapter used by other providers. A full source
  page can yield at most 4,000 normalized records because each source record may
  also derive one category; the 8 MiB internal cap remains fail-closed, and one
  full 2,000-record page may quarantine record-locally. Before the authenticated
  run can be called complete, record-local adapter/mapper defects must quarantine
  without aborting their whole source page, cross-page relationship quarantines
  need a bounded retry/reconciliation path, at-least-once source identity must
  prevent older catalog redelivery from regressing newer state, and a running
  immutable config pin must not depend on remaining the central active pointer.
  The live-only worker path must also stop requiring the unused capture-root and
  actor-HMAC settings. These are explicit Task 023 blockers; no source-head,
  rate, or full-import completion claim is made in this PR.
