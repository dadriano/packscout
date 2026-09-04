# Task: Store and Serve Pack Catalog V1

**ID:** pack-version-publication/005
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006, pack-version-publication/007
**Delivery phase:** P05
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder after dependencies are complete, including storage, authorization, concurrency, query, cursor, lifecycle, and saved-item verification
**Status:** in_progress

## Start Here

Create sealed fixtures for two packs and their required profiles, include one incomplete candidate, then record the expected storage, active-head, six-journey query, saved-item, lifecycle, and live-pagination results before and after activating only one complete pack.

## Objective

Provide the authenticated immutable public store and the sole `pack_catalog_v1` read API. Each pack is served from one atomic active head, remains internally complete, and can change without moving or blocking any unrelated pack.

## Context

A public pack snapshot is an immutable, complete rendering and calculation boundary containing its metadata, lifecycle, full contents, odds, chase, valuations, actions, and EV state. Bounded staging makes large snapshots safe to retry; finalization proves the complete artifact; one compare-and-swap changes the active head only after every invariant passes.

Public reads resolve each pack through its own active head. Provider profiles and standalone collectible profiles have separate immutable snapshots and atomic heads, while pack-local collectible data stays sealed inside the pack snapshot that references it. The catalog has no Heat field, dependency, ranking, filter, or presentation contract.

## Delivery Context

P05 is a sibling of P02, P03, and P04 from merged P01. Its review promise is a complete authenticated storage lifecycle and a complete server read contract that can be verified with fixtures. Merging does not connect buyer routes to the API and does not enable production writer credentials, schedules, or public mutations; P06 and P07 may consume the reviewed interfaces later.

## Requirements

### Immutable storage and finalization

- Accept bounded start, ordered-batch, finalize, status, and block operations for one authorized entity, immutable snapshot, and operation identity.
- Keep partial, failed, and blocked snapshots unreachable from every active pack or profile head.
- Finalize only after validating schema, stable identities, ordering, counts, batch hashes, aggregate content digest, dependencies, and byte-equivalent summary and detail projections.
- Return the original receipt for an exact repeated operation inside the 30-day replay window, return `OPERATION_EXPIRED` after that window, and reject changed bytes under an existing idempotency key or operation identity.
- Keep every completed pack, provider-profile, and collectible-profile snapshot immutable.

### Atomic heads and holds

- Activate one pack with a compare-and-swap over expected head generation, current snapshot, publication epoch, hold state, and next provider-local publication sequence.
- Store the active snapshot identity and its indexable summary in the same head transition, preserving the previous complete snapshot as the immediate recovery target.
- Permit one winner for competing same-pack transitions while unrelated pack and profile heads advance independently.
- Require active initial provider and referenced collectible profile heads before a pack's first activation; later profile changes never gate that pack.
- Reject stale sequences, stale epochs, normal activation while held, and older targets unless a protected rollback operation names the retained previous complete snapshot.

### Public catalog journeys

- Serve shell status, dashboard, pack listing, pack detail, collectible search, and packs containing a desired collectible through the `pack_catalog_v1` contract.
- Resolve every included pack's summary, detail, full membership, odds, chase, valuation, action eligibility, and EV from the single snapshot named by that pack's active head.
- Join each pack result to the current active provider-profile head for provider-wide fields; a missing required provider profile produces a bounded invariant failure for only its dependent result.
- Resolve standalone collectible search and saved collectible state through the current active collectible-profile head while retaining sealed collectible copies in pack-local results; a missing required profile fails only that dependent result.
- Omit a pack that has never completed its first activation without making another pack unavailable, and keep every public query within declared page, result, document, membership, and response-size limits.

### Identity, lifecycle, and saved state

- Use stable `publicRepackId` and `publicCollectibleId` values in responses, URLs, saves, filters, selections, and analytics; snapshot identities provide evidence and never replace stable identity.
- Keep the available-and-active browse/search view as the default while explicit all-state views, saved results, and direct detail reads expose sold-out, unavailable, unknown, and retired packs.
- Keep the last complete contents readable for every lifecycle state and enable purchase or promotion actions only when the pack is active and available.
- Validate saved pack identities against active pack heads and saved collectible identities against the active collectible-profile head without storing snapshot identities as save keys.
- Return stable structured unavailable, not-found, invalid-query, unauthorized, forbidden, conflict, and cursor-expired outcomes without exposing protected data.

### Native live pagination and safe merge

- Use signed, schema-bound live keyset cursors with deterministic sort tie-breaking by stable public identity and binding to query, filters, sort, direction, page size, issue time, and expiry.
- Keep each response coherent to one evaluation clock without freezing pack heads across pages; an activating pack may move, repeat, or be skipped after its sort key crosses the cursor.
- Keep a cursor valid when an unrelated pack activates and return `CURSOR_EXPIRED` only for an expired, malformed, tampered, or query-mismatched native cursor.
- Keep browser-safe contracts free of server implementations, credentials, raw storage records, operation evidence, and internal authorization data.
- Ensure merge alone creates no buyer route, enabled writer, enabled schedule, public mutation authority, or user-visible catalog behavior.

## User-Facing Behavior

When a buyer-facing route later uses this API, users can complete all six catalog journeys with stable URLs and saved identities. Every pack is either absent before its first complete activation or shown as one complete coherent snapshot; sold-out, unavailable, unknown, and retired packs remain reachable with ineligible actions disabled, and Heat is absent.

## Interface Contract

The authenticated pack write boundary exposes `startPublicPackSnapshot`, `applyPublicPackSnapshotBatch`, `finalizePublicPackSnapshot`, `activatePublicPackSnapshot`, `getPublicPackPublicationStatus`, `blockPublicPackSnapshot`, `holdPublicPackHead`, `activateRetainedPublicPackSnapshot`, and `resumePublicPackHead`. Hold increments the publication epoch atomically, retained activation requires a held head and its exact expected generation, and resume releases only the exact held generation and epoch.

The authenticated profile write boundary exposes `startPublicProfileSnapshot`, `applyPublicProfileSnapshotBatch`, `finalizePublicProfileSnapshot`, `activatePublicProfileSnapshot`, `getPublicProfilePublicationStatus`, and `blockPublicProfileSnapshot`. Every operation names provider or collectible kind and uses P01 `PublicProfileSnapshotIdentity`, `PublicProfileSnapshotDescriptor`, ordered `PublicProfileSnapshotBatch` values, `ProfileActivationIntent`, and its corresponding head; provider profiles require provider scope and collectible profiles require catalog scope.

`ActivePackHead`, `ActiveProviderProfileHead`, and `ActiveCollectibleProfileHead` are the only public reachability roots for their entity snapshots. Each head carries generation, active and previous snapshot identities, activation time, and the concurrency evidence required by its entity; `ActivePackHead` additionally carries publication epoch, hold state, accepted publication sequence, and the active indexable summary.

`PackCatalogQueries` exposes `getPublicShellStatus`, `getDashboardBundle`, `listPublicPacks`, `getPublicPack`, `searchPublicCollectibles`, and `findPacksByDesiredCollectible`. Every response declares schema `pack_catalog_v1`, evaluation time, stable public identities, and the active snapshot identities needed to prove cross-journey agreement; no response contains Heat or a whole-catalog identity.

`SavedCatalogItemsV1` implements P01 `getSavedItemIds({})`, `setSavedRepack({ publicRepackId, saved })`, and `setSavedCollectible({ publicCollectibleId, saved })` with the exact authentication, 250-per-kind bound, canonical ordering, idempotency, stale-removal, capacity-pruning, result, and error behavior. Resource checks use current V1 pack or collectible-profile heads directly. P06 uses `ConvexPublicPackPublicationClient` and `ConvexPublicProfilePublicationClient` implementations of the authenticated write boundary.

## Acceptance Criteria

### Storage and atomicity

- [ ] Missing, reordered, changed, incomplete, or cross-entity batches cannot finalize or become reachable.
- [ ] Exact repeated operations inside the replay window return their original receipt, expired operations return `OPERATION_EXPIRED`, and changed-byte reuse fails without mutation.
- [ ] Competing same-pack activations yield one winner and one bounded conflict, and readers observe only the prior or new complete snapshot.
- [ ] Different pack and profile heads activate independently after required initial profile heads exist.
- [ ] Stale sequence, stale epoch, held-head, unauthorized, expired, wrong-environment, and wrong-scope writes fail closed.

### Recovery mutations

- [ ] Holding a pack head atomically increments its epoch and prevents every prior-epoch normal activation.
- [ ] Retained-snapshot activation succeeds only for the exact previous complete snapshot while the expected head remains held.
- [ ] Resume releases only the exact expected held generation and epoch; exact repeats are idempotent and conflicts leave the head unchanged.

### Catalog behavior

- [ ] All six journeys agree on each pack's active snapshot, byte-equivalent projection, stable identities, complete membership, odds, chase, valuation, actions, and EV.
- [ ] Default and all-state fixtures expose the agreed lifecycle behavior, keep full contents readable, and enable actions only for active and available packs.
- [ ] Pack and collectible URLs and saves survive snapshot update, per-pack rollback, sold-out, unavailable, unknown, and retired states.
- [ ] Standalone collectible results use one active collectible-profile snapshot while pack-local results retain their sealed collectible copy.
- [ ] Heat is absent from responses, cursors, saved-item authority, ranking, filtering, dependencies, and error details.

### Saved-item behavior

- [ ] The three named saved-item operations match P01 inputs, results, errors, authentication, canonical ordering, and independent 250-item caps.
- [ ] Saving checks the current V1 head, removal remains possible without one, and repeated set operations converge without duplicate rows.
- [ ] At capacity, only the oldest unreachable item of the same kind may be pruned; otherwise the operation returns `SAVED_ITEM_LIMIT_REACHED` without mutation.

### Pagination and dormant delivery

- [ ] A two-page activation race proves live cursor validity, deterministic ties, current heads, and the documented move, repeat, or skip behavior.
- [ ] Expired, malformed, tampered, and query-mismatched cursors return `CURSOR_EXPIRED` without a loop or unstructured server failure.
- [ ] One missing initial pack head or one failed candidate does not make any active independent pack unavailable.
- [ ] Browser-safe exports contain no server implementation, credential, raw record, protected evidence, or mutation authority.
- [ ] Merging P05 changes no buyer route and leaves every production writer, schedule, and public mutation disabled.

## Verification

Named scenario: **Atomic store and six-journey catalog contract** — stage complete and incomplete fixtures, race pack and profile activations, exercise all lifecycle and saved-item states, paginate while one pack changes, attempt every invalid or unauthorized operation, and prove complete per-pack reads with no Heat or merge-time public activation.
