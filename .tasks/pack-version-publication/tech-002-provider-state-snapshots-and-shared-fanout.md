# Technical Spec: Provider State, Snapshot Assembly, and Shared Fan-Out

**ID:** pack-version-publication/tech-002
**Related tasks:** pack-version-publication/002, pack-version-publication/003, pack-version-publication/004
**Depends on technical specs:** pack-version-publication/tech-001
**Spec status:** draft

## Purpose

Make every relevant pipeline update durably identify its affected packs and produce independently claimable, complete snapshot work inside the owning provider database before source progress advances.

## Current System Context

### Confirmed repository facts

- `packages/database/src/ingestion-repository.ts` writes canonical page projections, queues EV recomputation, and advances the import run and provider cursor inside `commitPage`'s PostgreSQL transaction.
- The same repository exposes `projectSourceRecord`, `projectDerivedSourceRecord`, and `materializeAndProjectSourceRecord`; derived EV projections therefore have canonical write boundaries outside `commitPage`.
- `packages/services/src/catalog-projection-service.ts` and `provider-projection-service.ts` already map provider records into canonical pack, catalog-asset, and EV-input projections.
- The checked-out code uses one Prisma schema and one database lifecycle. PR 66 contains reviewed starting points for separate central/provider clients and a bounded provider database gateway.
- `apps/worker/src/provider-worker-runtime.ts` currently composes ingestion, EV recomputation, and retention in one provider cycle; it has no per-pack publication planner.

### Confirmed task constraints

- The provider database is authoritative for pack membership and publication history; central code cannot scan that membership.
- Direct pack, contents, odds, lifecycle, and EV changes identify every affected pack; irrelevant activity produces no publication work.
- Planning is complete only when every affected pack has a sequenced build request or an exact durable `no_change` result.
- Same-pack work serializes, while unrelated packs and providers can proceed independently.
- An unavailable provider leaves only its delivery pending and cannot hold another provider's work.

## Proposed Implementation

### Database authority foundation

Selectively extract the PR 66 central/provider database lifecycle, topology, credential-resolution, and bounded-gateway primitives. Generate separate Prisma clients from `packages/database/prisma/central/schema.prisma` and `packages/database/prisma/provider/schema.prisma`; keep the existing database lifecycle only until each current owner is assigned to one of those schemas during this clean-slate implementation.

Every provider database contains and validates a single immutable `database_identity` row. `BoundedProviderDatabaseGateway.runWithProviderDatabase` receives organization and provider identity, resolves the target server-side, verifies the identity row, enforces connection/time bounds, and returns a typed unavailable result. Connection targets and credentials never enter contracts, status DTOs, or logs.

### One transactional impact recorder

Add `ProviderPackImpactRecorder.recordCanonicalChanges(transaction, input)`. It must run inside every transaction that can create a canonical revision affecting `PublicPackSnapshot`, not as an after-commit event handler.

The input contains the exact created canonical revision identities, source boundary, organization, provider, and accepted time. The recorder:

1. Maps each revision to stable owning `publicRepackId` values using provider-local foreign keys and membership indexes.
2. Loads the current immutable identity vector required for each affected pack, including the expected EV request/result identity and initial profile prerequisites.
3. Evaluates `ready`, `waiting`, `blocked`, `no_change`, or `superseded` without contacting Convex or another provider.
4. Allocates `packPublicationSequence` and persists a `PackBuildRequest` for each distinct desired input digest, or persists an exact no-change receipt.
5. Returns a canonical impact digest that the caller stores with its page, derived projection, quarantine retry, or shared-delivery checkpoint.

Wire that recorder into `commitPage`, `projectSourceRecord`, `projectDerivedSourceRecord`, and `materializeAndProjectSourceRecord`. A changed EV calculation enters through `projectDerivedSourceRecord`; its canonical result and the resulting ready pack request commit together. A technical EV failure leaves the prior pack request waiting and the EV queue retryable.

The wake notification is best effort and occurs only after commit. Durable rows, not notification delivery, determine whether work exists.

### Impact and readiness behavior

Map direct changes through explicit generic relationships:

| Changed domain | Pack lookup |
|---|---|
| Pack metadata, price, lifecycle, odds, or EV | Native stable pack identity on the revision |
| Content membership or content snapshot | Owning pack foreign key |
| Pack-local collectible/category display copy | Active membership rows referencing the stable dependency |
| Eligible collectible valuation | Every containing pack, regardless of current chase winner |
| Pull, sale, Heat, health, credential, worker, save, or user state | No pack work |

`ProviderPackReadinessEvaluator` is deterministic over transaction-pinned rows. It admits a domain-valid EV `unavailable`, waits for absent/failed/expired/mismatched technical EV work, blocks permanent domain invalidity, and requires a complete prior sealed snapshot for lifecycle-only work.

Coalescing keeps history without redundant assembly. An identical desired-input digest records `no_change`; a higher sequence supersedes older unclaimed work for the same pack; a claimed or terminal activation intent is never reopened.

### Pure pack snapshot assembler

Implement `ProviderPackSnapshotAssembler` in `packages/services` with no repository, clock, network, environment, or authorization dependency. It accepts only the P01 validated, pinned input structure.

Assembly follows this order:

1. Verify stable provider/pack identities, complete membership, probability coverage, shared dependencies, EV evidence, lifecycle rules, and P01 size limits.
2. Normalize money, probabilities, text, timestamps, aliases, actions, and stable IDs using shared contract functions.
3. Select top chase from every eligible member by highest valuation, then ascending canonical-byte collectible ID.
4. Produce summary/search/detail projections and bounded ordered content batches from the same normalized object.
5. Hash batches and descriptor, derive `publicPackSnapshotId`, scan protected fields, and return `BuiltPublicPackSnapshot` with separate evidence.

For lifecycle-only work, clone a complete prior snapshot and permit changes only to lifecycle, action eligibility, provenance, and deterministic EV freeze/presentation evidence. Numeric economics and contents remain byte-identical.

### Shared changes and profiles

Central ingestion uses `SharedPackFanoutRepository.recordChangeAndAdvance`. One transaction stores the immutable shared change, complete in-scope provider audience, one delivery per provider, any provider/collectible profile snapshot and activation intent, and the central source checkpoint.

`SharedPackFanoutWorker` claims one provider delivery and calls `ProviderPackImpactPlanner.plan` through the bounded provider gateway. The provider planner expands exact pack membership locally and transactionally records requests/no-change receipts plus its result digest. Central acknowledgment accepts only that delivery ID and result digest.

Profile snapshot assembly reuses the same canonical encoding and bounded-batch utilities but has separate payload schemas. The central profile outbox serializes each profile identity independently. Initial pack activation declares required profile heads; later profile activations do not rewrite existing pack snapshots.

## Code Changes

### Database and service modules

1. Extract `central-database.ts`, `provider-database.ts`, `provider-database-gateway.ts`, `database-topology.ts`, and locator/destination-policy support from the pinned PR 66 commit.
2. Add `provider-pack-impact-repository.ts`, `provider-pack-publication-repository.ts`, and `shared-pack-fanout-repository.ts` under `packages/database/src`.
3. Add `provider-pack-impact-planner.ts`, `provider-pack-readiness-evaluator.ts`, `provider-pack-snapshot-assembler.ts`, and profile assembly under `packages/services/src`.
4. Add disabled worker compositions for local planning, shared delivery, pack assembly, and profile assembly under `apps/worker/src`.
5. Re-export only browser-safe types from contracts; keep Prisma clients, topology, leases, and source evidence inside database/service packages.

### Existing integration points

1. Update every canonical revision transaction in `packages/database/src/ingestion-repository.ts` to invoke the impact recorder before its progress write.
2. Update the catalog and EV projection repositories to return stable affected-domain identities rather than requiring later payload inspection.
3. Update `provider-worker-composition.ts`, `provider-worker-runtime.ts`, and runtime config to construct provider-scoped dependencies while leaving new processors disabled.
4. Add bounded post-commit wake publication based on the PR 66 activity-outbox pattern; polling remains sufficient for correctness.
5. Add unit and PostgreSQL integration fixtures for two databases, two packs per provider, direct changes, derived EV, and shared changes.

## Database / Schema Changes

### Provider schema

Add these provider-owned records with organization/provider checks on every unique and foreign key:

| Record group | Tables and key constraints |
|---|---|
| Impact | `pack_publication_change_receipts`; unique source-boundary plus pack; stores outcome and impact digest |
| Desired work | `pack_build_requests`; unique pack plus sequence and unique pack plus desired-input digest; state/reason and pinned identity JSON |
| Artifacts | `pack_snapshot_artifacts`, `pack_snapshot_batches`; unique pack plus content hash and artifact plus batch ordinal |
| Activation | `pack_activation_intents`, `pack_publication_operations`, `pack_publication_receipts`; immutable intent episodes and exact replays |
| Scheduling | `pack_publication_heads`, `pack_publication_wakes`; mirrored epoch/hold, lease fence, attempts, retry, and bounded wake state |

Use a provider-local PostgreSQL sequence for `packPublicationSequence`. Allocate it only when a distinct `PackBuildRequest` is inserted; cross-provider values are never compared.

Index claimable work by `(state, available_at, public_repack_id, pack_publication_sequence)` and lock rows with `FOR UPDATE SKIP LOCKED`. A partial unique constraint permits only one active claim per pack, and every mutation matches lease owner, fence, and unexpired database time.

### Central schema

Add these central records:

| Record group | Tables and key constraints |
|---|---|
| Source | `shared_catalog_changes`; unique immutable source identity and content digest |
| Audience | `shared_change_deliveries`; unique change plus provider, ordered shard, delivery state, lease, and acknowledgment digest |
| Profiles | `profile_snapshot_artifacts`, `profile_snapshot_batches`; unique kind/entity/content hash and batch ordinal |
| Profile work | `profile_activation_intents`, `profile_publication_operations`, `profile_publication_receipts` |
| Progress | `shared_change_checkpoints`, `shared_change_wakes`; exact audience digest and completed source boundary |

The source change, complete delivery set, profile intent set, and checkpoint receipt use one central transaction. Delivery acknowledgment is a later independent transaction and is not required for source checkpoint advancement.

## Interfaces, APIs, and Endpoints

`ProviderPackImpactPlanner.plan(input)` accepts either a provider-local canonical change boundary or a `SharedProviderChangeDelivery`. It returns the affected stable pack IDs, each durable request/no-change outcome, and one canonical result digest.

`ProviderPackReadinessEvaluator.evaluate(input)` returns `{ outcome, desiredInputDigest, pinnedDependencies, profilePrerequisites, reason }`, where outcome is `ready`, `waiting`, `blocked`, `no_change`, or `superseded`.

`ProviderPackBuildRequestRepository` exposes bounded `enqueue`, `claim`, `renew`, `markWaiting`, `markBlocked`, `markSuperseded`, and `complete` operations. `ProviderPackSnapshotRepository.sealAndEnqueueActivation` performs artifact reuse/seal, fenced request completion, and new activation-intent insertion in one transaction.

`ProviderPackPublicationOutboxRepository` exposes bounded `claim`, `renew`, `recordOperation`, `recordReceipt`, `scheduleRetry`, `block`, `supersede`, and `complete` operations. Every mutation matches provider, stable pack, activation intent, lease fence, idempotency key, request digest, and expected prior state.

`SharedPackFanoutRepository` exposes `recordChangeAndAdvance`, `claimDelivery`, `renewDelivery`, `acknowledgeDelivery`, and `recordDeliveryFailure`. Central callers never receive a provider Prisma client.

`ProviderProfileSnapshotRepository` and `CollectibleProfileSnapshotRepository` seal/reuse deterministic profile artifacts and create distinct activation intents. `CentralProfilePublicationOutboxRepository` owns bounded profile claims, operations, receipts, retries, blocks, supersession, and completion.

`ProviderPackSnapshotAssembler.assemble(input)` returns `BuiltPublicPackSnapshot` with `created` or `reused`; it cannot perform I/O. Provider and collectible profile assemblers return the analogous P01 profile envelope.

## Data Flow

### Direct provider update

1. The pipeline writes new canonical revisions in the owning provider transaction.
2. The impact recorder maps only created revisions to exact stable pack IDs.
3. Readiness pins current dependencies and writes a sequenced request or exact no-change receipt per affected pack.
4. The caller writes its page, quarantine, derived-projection, or cursor progress with the impact digest.
5. The transaction commits; a post-commit wake accelerates independently claimable pack work.

### Derived EV completion

1. The EV processor calculates against a pinned input identity.
2. `projectDerivedSourceRecord` writes the canonical EV result.
3. The impact recorder finds the owning pack and evaluates the now-matching result.
4. A greater local sequence supersedes its waiting request and records a ready request in the same transaction.
5. A worker may then claim that pack without scanning any provider or global catalog.

### Shared dependency update

1. Central persistence records the shared revision, exact provider audience, provider shards, profile intents, and source checkpoint atomically.
2. Healthy delivery workers claim their provider shard independently.
3. Each addressed provider expands membership and commits exact local pack results through its own gateway transaction.
4. Central persistence acknowledges only the returned delivery and result digest.
5. An unreachable provider stays pending while other providers and profiles continue.

## Error Handling and Edge Cases

- If impact persistence fails, the surrounding canonical transaction rolls back, so neither source progress nor the data update can outrun publication intent.
- If the post-commit wake is lost, bounded polling finds the durable request; duplicate wakes coalesce by digest.
- If a provider is unavailable, return `PROVIDER_UNREACHABLE` for that delivery only and preserve its lease-safe retry schedule.
- If a newer sequence appears during assembly, the older request may finish artifact computation but cannot seal/activate after its fence or expected state fails.
- If shared audience evidence is missing, contradictory, or over bounds, do not advance the central checkpoint and expose only a sanitized stable failure code.

## Testing and Verification

1. Add transaction-failure injection immediately before and after canonical write, request/no-change insert, checkpoint write, artifact seal, and activation-intent insert.
2. Run two-provider PostgreSQL integration tests proving credentials, leases, rows, and checkpoints cannot cross provider boundaries.
3. Exercise every direct domain mapping, derived EV result, irrelevant domain, shared dependency, lifecycle-only baseline, and top-chase dependency case.
4. Permute assembler input order and assert identical descriptor bytes, batches, hashes, projections, and snapshot identity; run protected-field and size-bound tests.
5. Run focused package tests, provider worker tests, database schema checks, and `npm run verify:framework` for each phase handoff.

The named scenarios are **Provider-local planning and persistence crash matrix**, **Complete deterministic pack snapshot suite**, and **Offline-provider fan-out and initial-profile recovery**.

## Open Questions and Risks

- Provider database isolation is not present on the checked-out branch. P02 must extract and verify the PR 66 lifecycle/gateway foundation before moving current provider-owned tables; this dependency belongs inside P02, not in a separate provider-wide publication phase.
- Existing canonical rows may not expose every stable foreign key needed for constant-time impact lookup. Add explicit membership and dependency indexes rather than scanning JSON payloads or an entire provider.
- A source update and its derived EV result are two desired states. The first may persist `waiting`; the derived result transaction creates the greater ready sequence and supersedes it without losing either audit boundary.
- Central provider-audience size must remain bounded. Persist the exact complete audience in ordered pages inside one logical transaction and fail before checkpoint advancement if the configured bound is exceeded.

## Handoff Notes

P02 owns database authority, direct impact persistence, desired work, and provider-local scheduling. P03 owns only the pure assembler. P04 owns central fan-out and profiles. All workers and schedules remain disabled after these phases merge.

The invariant to review first is: a successful relevant pipeline transaction cannot commit unless every affected pack is durably represented by a sequenced request or an exact no-change receipt. This is how the system always knows which individual packs need promotion to Convex.
