# Task: Store and Serve Pack Catalog V1

**ID:** pack-version-publication/005
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006, pack-version-publication/007
**Delivery phase:** P05
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder after dependencies are complete, including storage, authorization, concurrency, query, cursor, lifecycle, and saved-item verification
**Status:** done

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

- [x] Missing, reordered, changed, incomplete, or cross-entity batches cannot finalize or become reachable.
- [x] Exact repeated operations inside the replay window return their original receipt, expired operations return `OPERATION_EXPIRED`, and changed-byte reuse fails without mutation.
- [x] Competing same-pack activations yield one winner and one bounded conflict, and readers observe only the prior or new complete snapshot.
- [x] Different pack and profile heads activate independently after required initial profile heads exist.
- [x] Stale sequence, stale epoch, held-head, unauthorized, expired, wrong-environment, and wrong-scope writes fail closed.

### Recovery mutations

- [x] Holding a pack head atomically increments its epoch and prevents every prior-epoch normal activation.
- [x] Retained-snapshot activation succeeds only for the exact previous complete snapshot while the expected head remains held.
- [x] Resume releases only the exact expected held generation and epoch; exact repeats are idempotent and conflicts leave the head unchanged.

### Catalog behavior

- [x] All six journeys agree on each pack's active snapshot, byte-equivalent projection, stable identities, complete membership, odds, chase, valuation, actions, and EV.
- [x] Default and all-state fixtures expose the agreed lifecycle behavior, keep full contents readable, and enable actions only for active and available packs.
- [x] Pack and collectible URLs and saves survive snapshot update, per-pack rollback, sold-out, unavailable, unknown, and retired states.
- [x] Standalone collectible results use one active collectible-profile snapshot while pack-local results retain their sealed collectible copy.
- [x] Heat is absent from responses, cursors, saved-item authority, ranking, filtering, dependencies, and error details.

### Saved-item behavior

- [x] The three named saved-item operations match P01 inputs, results, errors, authentication, canonical ordering, and independent 250-item caps.
- [x] Saving checks the current V1 head, removal remains possible without one, and repeated set operations converge without duplicate rows.
- [x] At capacity, only the oldest unreachable item of the same kind may be pruned; otherwise the operation returns `SAVED_ITEM_LIMIT_REACHED` without mutation.

### Pagination and dormant delivery

- [x] A two-page activation race proves live cursor validity, deterministic ties, current heads, and the documented move, repeat, or skip behavior.
- [x] Expired, malformed, tampered, and query-mismatched cursors return `CURSOR_EXPIRED` without a loop or unstructured server failure.
- [x] One missing initial pack head or one failed candidate does not make any active independent pack unavailable.
- [x] Browser-safe exports contain no server implementation, credential, raw record, protected evidence, or mutation authority.
- [x] Merging P05 changes no buyer route and leaves every production writer, schedule, and public mutation disabled.

## Verification

Named scenario: **Atomic store and six-journey catalog contract** — stage complete and incomplete fixtures, race pack and profile activations, exercise all lifecycle and saved-item states, paginate while one pack changes, attempt every invalid or unauthorized operation, and prove complete per-pack reads with no Heat or merge-time public activation.

## Implementation Record — 2026-09-03

- **Branch:** `codex/pack-version-publication-p05-store`; verified parent `86e2a142` (`origin/main`, including merged #96 and #105); verified implementation `cba917ab`; review fixes `af924572`, `a995f62d`, and `7b319840`.
- **Measured limits (the tech-003 open question):** the P01 fixture builder at 25-character names produces 1,108 search-text characters for 50 contents (bound: 1,024) and a 1.35 MB pack header at 8,000 contents (Convex document bound: 1 MiB). Both figures come from `sealFixturePack` over payloads of 50, 400, 2,000, and 8,000 contents. The header without its two contents-derived vectors is 234 KB at 8,000 contents.
- **Resolution:** pack search text is title plus aliases (`packSearchText`), recorded in `pack-catalog-domain.ts`; the wire header omits `contents`, `collectibleProfileSnapshotIds`, and `valuationDependencyIdentities`, which the store rebuilds from the ordered batches before recomputing `contentSha256` at finalize. `PACK_SNAPSHOT_MAX_CONTENTS` stays 8,000.
- **Store shape:** `publicPackSnapshots` (root with running invariants), `publicPackSnapshotBatches`, `publicPackSnapshotBatchDependencies`, `publicPackMemberships`, `activePackHeads`, `activeProviderProfileHeads`, `activeCollectibleProfileHeads`, `publicProfileSnapshots`, `packCatalogOperations`. Heads are the only public reachability roots.
- **Authorization:** the existing HMAC boundary gains a `packCatalog` surface; every request then binds its P01 trusted service identity to the key's deployment authority (`PACKSCOUT_PACK_CATALOG_V1_PUBLICATION_KEYS`: environment, organization, scope) and to the exact entity and operation. Mismatches, expiry, and wrong runtime environment answer `403 PACK_CATALOG_AUTH_FORBIDDEN`; a provider-scoped key cannot touch another provider's pack.
- **Receipts:** exact repeats inside 30 days return the stored bytes; changed bytes under a known operation or idempotency key answer `conflict`; a repeat after the window answers `operation_expired`; domain refusals are receipts, never HTTP errors. Status reads store nothing.
- **Reads:** six head-driven internal queries plus public actions minting the clock; one index per sort path; list scans bounded at 2,000 heads per request with live cursor continuation, exact shell and dashboard counts up to the 8,000-head catalog maximum (fail closed beyond it), and desired-collectible discovery that skip-scans one distinct pack at a time (bounded at 2,000 packs); live signed keyset cursors reuse `PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY`; content pages pin one immutable snapshot and answer `CURSOR_EXPIRED` once it is gone.
- **Saved items:** `packCatalogSavedItems` implements `SavedCatalogItemsV1` over the existing `savedRepacks` / `savedCollectibles` tables, resolving V1 heads; the live `savedItems` module is untouched so no user-visible behavior changes before P07.
- **Dormancy:** no cron, worker, buyer route, or writer credential is enabled. The 15 routes refuse every request until both key environment variables are configured.

## Spec Compliance

- Related specs reviewed: pack-version-publication/tech-001, pack-version-publication/tech-003, pack-version-publication/tech-004
- Alignment: implemented as specified for the authenticated operation protocol, staged immutable snapshots, compare-and-swap heads, hold/retained/resume fencing, exact replay, six head-driven journeys, live keyset cursors, and V1 saved items.
- Divergences:
  - Pack search text is title plus aliases rather than every collectible display name (tech-001, tech-004); the measured P01 fixture cannot seal a 50-content pack under the original rule. P03's assembler adopts the same rule at rebase.
  - The `start` request carries the header without the two contents-derived vectors; the store stores them per batch (`publicPackSnapshotBatchDependencies`) and reassembles them at finalize, so the maximum pack never needs one document or request above the P01 batch bound (tech-003 open question).
  - Desired-collectible lookup uses exact `publicPackMemberships` rows written at batch time and verified against the active snapshot at read time, not membership tokens in a search index; Convex text search is fuzzy and unordered (tech-003 anticipated this fallback).
  - Profiles keep their single batch on the snapshot root; there is no `publicProfileSnapshotBatches` table. Receipts live on `packCatalogOperations`; there is no separate `packCatalogReceipts` table (tech-003 table list).
  - Collectible search pages by normalized display name with a bounded substring scan rather than a search index, so its cursors are deterministic live keysets like the pack lists.
  - `SavedCatalogItemsV1` is a new dormant module instead of a rewire of `convex/savedItems.ts` (tech-004), because the live module serves production saves against V3 until P07 switches the frontend.
  - Public read refusals under the closed beta answer the non-leaking `CATALOG_UNAVAILABLE`, matching the existing catalog read gate; `AUTH_REQUIRED` and `UNAUTHORIZED` remain reserved.
  - The P01 read contract was extended with `providerProfiles` / `providerProfile` so the task's current-provider-profile join has a place in every result; the P01 fixture pages and contract matrix carry the new fields.
  - Authorization failures are HTTP `403` refusals rather than `refused` receipts, so an unauthorized caller consumes no operation identity and learns no catalog state.
  - `convex/_generated/api.d.ts` and `server.d.ts` are patched by hand for the new modules and environment variable; `convex codegen` requires a configured deployment in this environment.
- Review corrections (automated review of PR #108, commits `af924572`, `a995f62d`, and `7b319840`):
  - A normal activation must carry the exact provider-local sequence and evidence under which the snapshot bytes were staged or last re-declared through `start`; re-declaring the same bytes under a later sequence records that declaration, so an older complete snapshot cannot re-enter through the normal path without the planner asking for it.
  - A first publication requires the referenced provider and collectible profile snapshots to be the current heads at staging and re-proves every reference at first activation from the per-batch dependency rows.
  - Activation refuses intents created at or after the sealed EV evidence's `validUntil` (`EV_INPUTS_PENDING`), reproducing the P01 publication-envelope rule inside the store.
  - List, desired-collectible, and collectible-search cursors continue from the last scanned keyset position when the scan budget truncates a sparse filter.
  - The preproduction fresh-target preflight allowlist names the nine `pack_catalog_v1` tables.
  - Shell status and dashboard totals are exact or fail closed with `CATALOG_UNAVAILABLE` beyond the 8,000-head catalog maximum; a capped count is never reported as exact.
  - Desired-collectible discovery skip-scans the membership index one distinct pack at a time and checks each pack's active snapshot, so retained snapshot versions neither consume the budget nor hide later packs.
  - Every content-cursor decoding defect, including invalid base64 in a syntactically accepted cursor, answers `CURSOR_EXPIRED`.
  - First activation verifies the bounded prerequisite proof sealed at staging (provider head plus per-batch verified collectible references, tech-003) instead of re-reading one head per content, which could not fit a transaction at the 8,000-content maximum; a collectible profile advancing between staging and activation does not invalidate the pack because profile heads are never deleted and the pack keeps its sealed collectible copy.
  - A fresh operation whose outcome is a conflict is stored like every other durable outcome, so exact retries return the same receipt and the identity cannot be reused with corrected bytes.
  - Replay and status lookups accept only records inside the caller's authority scope and entity; a foreign operation identity answers `AUTHORIZATION_REFUSED` or reads as absent.
  - Pack list, dashboard, desired-collectible, and detail reads join the current active provider profile. The `pack_catalog_v1` read contract gained `providerProfiles` on page results and `providerProfile` on detail (a P01 extension recorded here; the P01 fixture and matrix were updated), and a pack whose provider profile is unavailable fails alone: omitted from pages and totals, `CATALOG_UNAVAILABLE` on direct detail.
- Verification: `npx vitest run convex/packCatalogStore.test.ts convex/packCatalogV1.test.ts` (20 tests, transaction limits enforced, real signed HTTP boundary); `npm run test:contracts` (455 tests); `node --import tsx --test packages/services/src/convex-pack-catalog-publication-client.test.ts` (5 checks); `npm run typecheck`; `npm run build`; `npm run scan:framework-standards:ratchet` (0 findings); `npm run check:framework`; `npm run check:prisma`. Product lanes services (one pre-existing failure, below), worker, frontend, admin, and ops-panel pass; the Convex lane passes (48 files, 446 tests; three heavy V3 tests time out only when run alongside the tooling lane and pass in isolation). The PostgreSQL lane passes on this branch and on clean `origin/main` once `LC_ALL`/`LANG` are set (the disposable server refuses to start under the tool shell's unset locale). The tooling lane (`npm run test:tooling`, same locale) runs 1,444 tests with 9 opt-in skips and 2 failures, `provider-continuous-policy.test.mjs` and `provider-resident-policy.test.mjs`, both of which fail identically on clean `origin/main`; the allowlist fix removed the one failure this branch had introduced.
- Review size: 36 authored code files, 5,396 added and 42 deleted lines, plus 23 generated lines and the task records; over the 25-file / 2,500-line target and slightly over the 5,000-line figure P01 cited as its hard stop, under the recorded P05 size exception (store, read API, and protocol are one integrity thesis). About 1,680 of those lines are tests and test support that exercise the security boundary directly, as the framework standard requires.
