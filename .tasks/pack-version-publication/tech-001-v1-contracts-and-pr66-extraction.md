# Technical Spec: V1 Contracts and PR 66 Extraction

**ID:** pack-version-publication/tech-001
**Related tasks:** pack-version-publication/001, pack-version-publication/002, pack-version-publication/003, pack-version-publication/004, pack-version-publication/005, pack-version-publication/006, pack-version-publication/007, pack-version-publication/008, pack-version-publication/009, pack-version-publication/010
**Depends on technical specs:** none
**Spec status:** draft

## Purpose

Establish one executable `pack_catalog_v1` contract and a selective PR 66 extraction ledger so every later phase implements atomic state for one pack without carrying provider-wide publication behavior.

## Current System Context

### Confirmed repository facts

- `packages/contracts` uses Zod schemas as the browser-safe validation boundary and exports them through `packages/contracts/src/index.ts`.
- The current catalog queries in `convex/publicRepacks.ts` resolve a single catalog-wide release and require that release identity in detail and cursor behavior.
- `convex/savedItems.ts` already derives ownership from `ctx.auth.getUserIdentity().tokenIdentifier`, caps each saved set at 250, sorts IDs, and prunes unavailable saves at capacity.
- PR 66 is available locally at immutable commit `51d2be47b42f8653d7f67592b1678baa9efa239d`; it contains useful isolation, hashing, lease, outbox, receipt, monitoring, and retention primitives.

### Confirmed product decisions

- `pack_catalog_v1` is the first and sole public catalog contract; there is no application source switch or compatibility layer.
- One immutable `PublicPackSnapshot` contains all fields needed to render and calculate one pack, including full contents; one `ActivePackHead` selects it atomically.
- Provider and collectible profiles publish independently, while pack-local display and calculation dependencies remain sealed in the pack snapshot.
- Heat is absent from contracts, storage, reads, filters, calculations, presentation, and operations.
- Ingestion and publication may pause, but already active heads must remain readable.

## Proposed Implementation

### Contract modules

Create a cohesive contract family under `packages/contracts/src` and export only its public members from the package barrel.

| Module | Responsibility |
|---|---|
| `pack-catalog-v1.ts` | Schema discriminator, common constants, and public exports |
| `pack-catalog-domain.ts` | Stable identities, lifecycle, money, snapshot, profile, and head schemas |
| `pack-publication.ts` | Build requests, intents, work states, reasons, operations, and receipts |
| `pack-catalog-query.ts` | Six public query inputs/results, keyset cursors, saves, and structured errors |
| `pack-catalog-operations.ts` | Status, recovery, worker gate, retention, readiness, and launch artifacts |

Add `pack-catalog-fixtures.ts` and focused `*.test.ts` files beside those modules. The fixture is executable production-shaped data, not test-only structural casting.

### Canonical snapshot rules

1. Normalize strings, stable IDs, integer minor-unit money, decimal probability representation, timestamps, optional values, and ordered collections before hashing.
2. Sort pack contents by canonical-byte `publicCollectibleId`; sort aliases, categories, actions, promotions, dependency identities, and batch descriptors by their declared stable keys.
3. Hash each bounded batch in the domain `packscout.public-pack-snapshot.v1`, then hash the descriptor and ordered batch hashes to obtain `contentSha256`.
4. Keep operational timestamps, attempts, leases, receipts, and active-head state outside canonical snapshot bytes.
5. Require the summary, search projection, detail, chase, action eligibility, and EV projection to be derivable from the same completed snapshot bytes.

`PublicPackSnapshot` must include these five bounded groups:

- Identity, provider reference, pack title/media/category, price, lifecycle, availability, and provenance.
- Complete ordered content membership with quantity, probability, display data, category, valuation, and valuation evidence.
- Probability coverage, normalization evidence, top-chase selection, and all eligible valuation dependency identities.
- EV inputs, result or domain-valid `unavailable`, currency, calculation time, method identity, and policy identity.
- Pack-local actions and the exact flags/reasons that determine whether an action is enabled.

Profile snapshots stay narrow. `PublicProviderProfile` owns stable provider identity, display name, brand assets, and provider-wide promotion copy/actions. `PublicCollectibleProfile` owns stable collectible identity, display name, image, category, aliases/search text, and current valuation display evidence.

### Shared vocabularies

Use the exact durable work states `waiting`, `ready`, `publishing`, `retry_scheduled`, `blocked`, `published`, `superseded`, and `rolled_back`; `held` is a separate head modifier. Planner-only `no_change` is not a durable work state.

Use the exact operation outcomes `applied`, `already_applied`, `already_active`, `conflict`, `refused`, and `operation_expired`. Every response returns the current durable state even when no mutation occurred.

Split reason codes into readable groups while exporting one union:

- Content: `INCOMPLETE_CONTENTS`, `INVALID_PROBABILITIES`, `INVALID_DOMAIN_DATA`.
- EV: `EV_INPUTS_PENDING`, `EV_TECHNICAL_RETRY`.
- Dependencies: `PROFILE_HEAD_MISSING`, `PROVIDER_UNREACHABLE`.
- Delivery: `TRANSPORT_TIMEOUT`, `RECEIPT_AMBIGUOUS`, `LEASE_LOST`, `ACTIVATION_CONFLICT`.
- Control: `OPERATOR_HOLD`, `AUTHORIZATION_REFUSED`, `OPERATION_EXPIRED`.

### Selective PR 66 donor ledger

Extract code from the pinned commit by file or symbol; do not merge or cherry-pick the branch. Every extracted primitive receives pack/profile names and tests before it enters a phase.

| Donor at pinned commit | Carry forward | Required rewrite |
|---|---|---|
| `central-database.ts`, `provider-database.ts`, `provider-database-gateway.ts`, topology and locator modules | Bounded independent client lifecycles, routing, failure classification, and drain behavior | Make provider identity and organization scope explicit in every call |
| `interruptible-canonical-sha256.ts` | Canonical plain-object hashing, cancellation, and event-loop yielding | Use the pack snapshot hash domain and contract normalizers |
| `promotion-job-persistence-types.ts`, `split-promotion-job-store.ts`, `split-promotion-job-recovery.ts` | Coalescing, claims, lease fencing, exact replay, tombstones, and bounded retention | Key ownership and order by stable pack identity plus provider-local sequence |
| `provider-activity-contract.ts`, `provider-activity-outbox-repository.ts`, `provider-activity-relay.ts` | Transactional outbox, fair relay, retry timing, and best-effort wake notification | Deliver central shared-change shards and provider-local pack work only |
| `provider-release-money.ts`, `provider-release-integrity.ts` | Money normalization, protected-field scanning, canonical batch verification, and chase helpers | Operate on one complete pack or one profile snapshot |

The following behavior families are references only and must be reimplemented against the contracts in this spec:

| Reference files/family | Keep as an idea | Do not carry |
|---|---|---|
| `packages/database/src/provider-release-publication-repository.ts`, `packages/services/src/distributed-provider-release-publication-service.ts` | Persist request before send, verify receipts, reconcile unknown results | Provider-wide descriptor, provider-wide completion head, and provider-wide lock |
| `convex/providerReleaseStart.ts`, `providerReleaseBatch.ts`, `providerReleaseFinalize.ts`, `providerReleaseState.ts`, `providerReleaseOperations.ts`, `providerReleaseProof.ts` | Idempotent staged writes, bounded batches, integrity checks | Finalization that also advances a shared provider head |
| `packages/contracts/src/promotion-job-monitoring.ts`, service cursor/judgment modules, and `apps/admin/server/promotion-job-monitoring-runtime.ts` | Bounded DTOs, stable ordering, signed query binding | Provider-job status as the primary entity |
| `packages/database/src/catalog-promotion-retention-proof.ts`, `catalog-promotion-retention-repository.ts`, `catalog-promotion-retention-types.ts` | Root collection, dry run, digest-bound deletion, resume receipts | Any root or deletion group spanning unrelated packs |
| Launch and manifest modules | Fenced worker control and immutable evidence | Global manifest authority, application selector, and parallel catalog paths |

No conversion module, compatibility shim, provider-specific branch in generic code, or Heat artifact is part of the extraction.

## Code Changes

1. Add the five contract modules and export them from `packages/contracts/src/index.ts`.
2. Add canonical serialization helpers that accept only validated plain data and reject unknown keys, protected fields, non-finite values, unsafe integers, and unordered inputs.
3. Add a two-pack fixture with provider/profile dependencies, every lifecycle state, EV available/unavailable/waiting/blocked cases, two pages, and saved identities.
4. Add contract tests proving schema strictness, deterministic bytes, pack isolation, profile independence, cursor binding, stable error unions, and operation replay fields.
5. Remove public-contract imports of release-wide identity and Heat when the sole V1 consumers land in P05 and P07; P01 itself leaves runtime code unchanged.

## Database / Schema Changes

None in P01. The contract fixture defines field names, nullability, bounds, index keys, and hash inputs that P02 through P05 must use without redefining them.

## Interfaces, APIs, and Endpoints

The pack publication types are `PublicPackSnapshotIdentity`, `PublicPackSnapshotDescriptor`, `PublicPackSnapshotBatch`, `PublicPackSnapshot`, `PackSnapshotEvidence`, `PackBuildRequest`, `PackActivationIntent`, and `ActivePackHead`.

The profile types are `PublicProfileSnapshotIdentity`, `PublicProfileSnapshotDescriptor`, `PublicProfileSnapshotBatch`, `PublicProviderProfile`, `PublicCollectibleProfile`, `ProfileActivationIntent`, `ProfilePublicationEnvelope`, `ActiveProviderProfileHead`, and `ActiveCollectibleProfileHead`.

`PublicationWorkState`, `PublicationOperationOutcome`, and `PublicationReasonCode` are the shared strict unions defined above. Repositories, remote operations, receipts, alerts, and Admin DTOs import these schemas rather than declaring local strings.

The read surface has exactly these names:

- `getPublicShellStatus` and `getDashboardBundle`.
- `listPublicPacks` and `getPublicPack`.
- `searchPublicCollectibles` and `findPacksByDesiredCollectible`.

`SavedCatalogItemsV1` has exactly `getSavedItemIds({})`, `setSavedRepack({ publicRepackId, saved })`, and `setSavedCollectible({ publicCollectibleId, saved })`. Set operations return `{ saved, prunedUnavailable }`.

The saved error union is split for readability:

- Identity: `AUTH_REQUIRED`, `AUTH_IDENTITY_INVALID`.
- Input: `INVALID_PUBLIC_REPACK_ID`, `INVALID_PUBLIC_COLLECTIBLE_ID`.
- State: `SAVED_RESOURCE_UNAVAILABLE`, `SAVED_ITEM_LIMIT_REACHED`, `SAVED_ITEMS_STATE_CONFLICT`.

`PackCatalogCursor` is opaque, signed, schema-bound, and query-bound. Its decoded payload contains operation, normalized filters, sort, direction, page size, last sort key, last stable ID, issue time, expiry, and—only for pack-content continuation—the immutable snapshot ID.

## Data Flow

### Contract fixture

1. Build provider and collectible profile fixtures with deterministic stable identities.
2. Build complete inputs for packs A and B, including every content member and EV dependency.
3. Canonicalize, batch, and hash each pack independently.
4. Activate only pack A and assert pack B's bytes and head remain unchanged.
5. Exercise every read, lifecycle, cursor, save, replay, and structured-error result against the same fixture.

### PR 66 extraction

1. Pin `51d2be47b42f8653d7f67592b1678baa9efa239d` in the implementation PR description.
2. Copy the smallest named symbol or test fixture needed by the target phase.
3. Rename its domain to pack/profile ownership before connecting it to production code.
4. Delete assumptions that require provider-wide completion, ordering, locking, or activation.
5. Prove the extracted behavior with the P01 two-pack isolation fixture.

## Error Handling and Edge Cases

- Reject partial contents, probability gaps, mismatched source identities, mismatched EV inputs, protected fields, and non-canonical collection order before artifact seal.
- Publish a domain-valid EV result of `unavailable`; leave transient technical EV work waiting and permanently invalid domain input blocked.
- Break equal top-chase valuations by ascending canonical-byte `publicCollectibleId`; include every eligible candidate valuation in the dependency digest.
- Reject changed-body idempotency replay, stale head generation, stale publication epoch, wrong scope, and expired operations without altering a head.
- Return `CURSOR_EXPIRED` for malformed, tampered, expired, wrong-operation, or query-mismatched cursors; never silently restart on the server.

## Testing and Verification

1. Run contract unit tests through the `@packscout/contracts` package test command.
2. Run property-style permutations of content, alias, action, and dependency order and assert identical canonical bytes.
3. Mutate each protected input independently and assert only the affected pack's content hash changes.
4. Snapshot every exact work state, reason, operation outcome, query error, saved error, and authorization scope.
5. Run `npm run verify:framework` before P01 handoff.

The named acceptance scenario is **Native pack catalog contract matrix** from task 001.

## Open Questions and Risks

- P01 must freeze `PACK_SNAPSHOT_BATCH_MAX_ITEMS`, maximum canonical batch bytes, maximum contents per pack, query page bounds, and cursor lifetime. Start validation with 250 items, 480,000 canonical bytes, 8,000 content rows, 50 list rows, 100 detail-content rows, and a 15-minute cursor lifetime; change these only from measured Convex and provider fixtures.
- A public field added after P01 can invalidate every producer and consumer. Change the shared schema and two-pack fixture first, then update dependent phases in dependency order.
- Extracted PR 66 code may hide provider-wide assumptions in names, keys, or tests. Treat any operation lacking a stable pack/profile identity as rejected until rewritten.

## Handoff Notes

P01 owns the contract files and executable fixtures only. P02 through P10 import those types rather than restating shapes or status vocabularies.

PR 66 extraction is source-controlled archaeology, not a merge strategy. Use `git show 51d2be47b42f8653d7f67592b1678baa9efa239d:<path>` for each approved donor, preserve attribution in the implementation PR, and review the resulting diff as new pack/profile code.

The next implementation action is P01: land the contract fixture and its pack-A/pack-B byte-isolation proof before any database or Convex work begins.
