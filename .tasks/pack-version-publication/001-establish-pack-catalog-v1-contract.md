# Task: Establish the Pack Catalog V1 Contract

**ID:** pack-version-publication/001
**Depends on:** none
**Blocks:** pack-version-publication/002, pack-version-publication/003, pack-version-publication/004, pack-version-publication/005
**Delivery phase:** P01
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including executable contract fixtures and boundary verification
**Status:** done

## Handoff — 2026-09-04

Complete and merged in [PR88](https://github.com/dadriano/packscout/pull/88), merge `c66f8666229455fd95d7dca58d3d85a391c01f21`. Do not rebuild it. P02, P04, and P05 start from this foundation; P03 additionally depends on P02's captured-input contract. P05 is also merged; its task record documents the shared search/header/provider-profile read contract corrections that later phases must consume. Historical verification and spec adaptations are below.

Shared resume instructions: [_handoff.md](_handoff.md). This is a status/context update, not authorization to begin a later phase.

## Start Here

Define one executable fixture containing two independently managed packs, their provider and collectible profiles, every lifecycle state, a valid EV-unavailable result, and a signed two-page query; record the exact snapshot, head, and cursor outcomes.

## Objective

Establish `pack_catalog_v1` as the sole public catalog contract and define the invariants every producer, publisher, store, query, and client must preserve. One pack is always published and read as one immutable, complete domain snapshot selected by one atomic head.

## Context

The unit users need to remain coherent is an individual pack. Pack metadata, lifecycle, full contents, odds, chase, valuations, EV, and actions cannot be assembled from independently changing public records without risking a mixed result. Each pack therefore owns immutable snapshots and an independently advancing head.

Provider databases remain authoritative for provider-owned pack state and operate independently. Centrally owned provider, collectible, category, display, alias, and valuation data crosses that boundary through immutable identities. Provider and collectible profiles have their own atomic heads, while every pack snapshot seals the shared fields needed to render and calculate that pack.

A pack snapshot ID names a domain-state revision within `pack_catalog_v1`; it does not name another catalog schema. The stable public pack and collectible IDs remain the native identities used by URLs, saves, filters, operations, and analytics.

## Delivery Context

P01 is the merged root contract phase. Its review promise is executable types, fixtures, validation rules, and invariants only. It changes no database, public head, route, schedule, credential, or user-visible behavior. P02, P04, and P05 are sibling foundations; P03 additionally depends on P02's executable captured-input contract.

## Requirements

### Atomic catalog model

- Define `pack_catalog_v1` as the only public catalog schema and `PublicPackSnapshot` as the complete rendering and calculation boundary for one pack.
- Require metadata, mapped lifecycle, price, full contents, probability coverage, pack-specific actions, chase, collectible/category display data, valuations, EV inputs, EV result, and EV policy identity in one snapshot.
- Define `ActivePackHead` as the only reachability pointer for a pack and require one compare-and-swap to select one completed snapshot.
- Ensure list, detail, search, desired-collectible, action, chase, and EV projections for a pack are byte-equivalent views of the snapshot selected by that head.
- Keep Heat, pulls, provider health, worker state, credentials, source evidence, exact collectible instances, and user data outside `PublicPackSnapshot`.

### Profiles and first publication

- Define immutable `PublicProviderProfile` snapshots with stable provider identity, display name, brand assets, and provider-wide promotion copy/actions; define immutable `PublicCollectibleProfile` snapshots with stable collectible identity, display name, image, category, aliases/search text, and current valuation display evidence. Give each kind independent atomic heads.
- Require a pack's first head activation to find an active provider profile and active collectible profiles for every referenced stable collectible identity.
- Allow every later pack activation to proceed without waiting for a newer profile snapshot after those initial heads exist.
- Keep provider-wide display and promotion fields in the provider profile so a provider-wide change does not change pack snapshot bytes.
- Keep pack-local collectible, category, display, and valuation copies sealed when an independently published profile changes.

### Identity and lifecycle

- Preserve native `publicRepackId` and `publicCollectibleId` values across snapshot publication, rollback, lifecycle changes, URLs, saves, filters, and analytics.
- Map canonical `active` to public `available` and canonical `disabled` to public `unavailable`; preserve canonical `sold_out` and `unknown` explicitly.
- Mark retirement as `retired` only from explicit persisted provider evidence and never from omission, timeout, unreachable source state, or failed work.
- Keep every availability and retirement combination readable, while enabling purchase or promotion actions only when availability is `available` and retirement is `active`.
- Require lifecycle-only work to retain the last complete contents and numeric economics while changing lifecycle provenance, eligible actions, and deterministic EV presentation or freeze metadata.

### Economics and completeness

- Require complete content membership and valid probability coverage; intentional or accidental partial contents cannot form a completed snapshot.
- Define top chase as the highest-valued eligible collectible, breaking equal valuations by ascending canonical-byte `publicCollectibleId`, and seal every eligible member's valuation dependency plus the chosen result.
- Represent a valid domain result with no calculable EV as explicit `unavailable` without inventing a numeric value.
- Treat missing, failed, expired, or input-mismatched EV calculation work as non-publishable; permanently invalid domain data remains blocked with a stable reason.
- Bind each completed snapshot to the exact EV method, policy, pack inputs, contents, odds, and valuation identities used to calculate it.

### Ordering, recovery, and security

- Assign each distinct desired pack state a provider-local monotonic `packPublicationSequence` before assembly; no sequence from another provider participates in its order.
- Define an immutable provider-scoped `SharedProviderChangeDelivery` and carry its central change identity, provider change sequence, and shared-dependency identities as separate evidence rather than combining them into a cross-database clock.
- Reuse byte-identical snapshot artifacts by stable pack identity and content hash while creating a distinct activation intent for each activation episode.
- Bind publication operations to environment, organization, provider or catalog scope, entity, snapshot, digest, expiry, and idempotency; changed-byte replay must fail closed.
- Bound operation replay to 30 days, return `OPERATION_EXPIRED` afterward, and exclude credentials, raw source data, connection targets, stack traces, and unbounded reason text from public or operational records.

### Publication states and reasons

- Use `waiting`, `ready`, `publishing`, `retry_scheduled`, `blocked`, `published`, `superseded`, and `rolled_back` as the complete durable work-state vocabulary; represent `held` as a separate head modifier.
- Treat `published`, `superseded`, `rolled_back`, and permanently invalid `blocked` work as terminal for that request; alert age applies only to unheld `waiting`, `ready`, `publishing`, and `retry_scheduled` work.
- Keep planner result `no_change` and operation outcomes `applied`, `already_applied`, `already_active`, `conflict`, `refused`, and `operation_expired` separate from durable work state and always return the resulting current state.
- Define exact reason codes `INCOMPLETE_CONTENTS`, `INVALID_PROBABILITIES`, `EV_INPUTS_PENDING`, `EV_TECHNICAL_RETRY`, `INVALID_DOMAIN_DATA`, `PROFILE_HEAD_MISSING`, `PROVIDER_UNREACHABLE`, `TRANSPORT_TIMEOUT`, `RECEIPT_AMBIGUOUS`, `LEASE_LOST`, `ACTIVATION_CONFLICT`, `OPERATOR_HOLD`, `AUTHORIZATION_REFUSED`, and `OPERATION_EXPIRED`.
- Map transient technical causes to `waiting` or `retry_scheduled`, permanent invalid inputs to `blocked`, successful active-head evidence to `published`, and replaced desired work to `superseded`.

### Authorization

- Use existing `providers:view` for read-only publication status and grant it to active `admin` and `data_operator` roles within their organization.
- Define `pack_publication:recover`, `pack_catalog:launch`, and `pack_catalog:prune` as distinct admin-only permissions; no `data_operator` receives them.
- Require trusted service identities with exact environment, organization, provider or catalog, entity, operation, and expiry scope for automated writes.
- Keep all publication mutations outside browser, public HTTP, and Admin routes even when the actor holds an admin-only permission.

### Native query and cursor behavior

- Define shell status, dashboard, pack list, pack detail, collectible search, and desired-collectible lookup directly under `pack_catalog_v1`.
- Default browse and search to retirement `active` plus availability `available`, while explicit all-state queries, saves, and direct detail requests can resolve every lifecycle state.
- Define `PackCatalogCursor` as a signed, schema-bound live keyset cursor with query, filter, sort, direction, page size, last sort key, last stable identity, issue time, and expiry.
- Keep each response coherent to one evaluation time without freezing changing pack heads between requests; sort-key changes may move, repeat, or skip an item in later traversal.
- Return bounded `CURSOR_EXPIRED` for expired, malformed, tampered, or wrong-schema cursors and stable structured outcomes for unavailable, not-found, invalid-query, and unauthorized requests.

### Saved-item behavior

- Keep the existing native operation names `getSavedItemIds`, `setSavedRepack`, and `setSavedCollectible`, but bind their resource checks directly to V1 pack and collectible-profile heads.
- Derive the save owner only from the authenticated identity, cap saved packs and collectibles at 250 each, store only stable public identities, and return both ID lists in canonical ascending order.
- Make set operations idempotent, permit removal after a head disappears, and on a full set prune the oldest no-longer-reachable item of that same kind before refusing a new save.
- Return `{ saved, prunedUnavailable }` from set operations and only the exact bounded errors `AUTH_REQUIRED`, `AUTH_IDENTITY_INVALID`, `INVALID_PUBLIC_REPACK_ID`, `INVALID_PUBLIC_COLLECTIBLE_ID`, `SAVED_RESOURCE_UNAVAILABLE`, `SAVED_ITEM_LIMIT_REACHED`, or `SAVED_ITEMS_STATE_CONFLICT`.

## User-Facing Behavior

Users receive one internally coherent pack at a time: metadata, contents, odds, chase, valuations, EV, lifecycle, and actions always come from the same completed snapshot. Stable pack and collectible identities remain usable as the pack changes. Browse and search initially show available packs, while explicit lifecycle views, saved items, and direct links can show any state with ineligible actions disabled.

## Interface Contract

`PublicPackSnapshotIdentity` carries `providerId`, `publicRepackId`, `publicPackSnapshotId`, `contentSha256`, pinned data time, and EV method and policy identities. `PublicPackSnapshot` carries the complete pack detail, a byte-equivalent summary/search projection, and full collectible membership. Operational completion and activation times live in receipts and heads outside the canonical snapshot bytes and content hash.

`PublicPackSnapshotDescriptor` carries the immutable identity, lifecycle and provenance, counts, dependency digests, ordered batch manifest, and completion state. Each bounded `PublicPackSnapshotBatch` contributes its hash to the descriptor's aggregate content hash. `PackSnapshotEvidence` carries provider change sequence and the immutable shared-dependency identity vector separately from public bytes.

`PublicProfileSnapshotIdentity` carries profile kind, stable provider or collectible identity, snapshot identity, content digest, source identity, and pinned data time. `PublicProviderProfile` and `PublicCollectibleProfile` carry the exact bounded fields declared above. `PublicProfileSnapshotDescriptor` and ordered `PublicProfileSnapshotBatch` values prove complete bounded bytes. `ProfileActivationIntent` identifies one target profile snapshot and activation episode, and `ProfilePublicationEnvelope` binds that intent to the identity, descriptor, ordered batches, payload digest, and authorization scope needed by the publisher.

`PackBuildRequest` pins one desired state, provider, stable pack identity, provider-local `packPublicationSequence`, source identities, full input dependencies, profile prerequisites, and expected publication epoch before assembly. `PackActivationIntent` names a distinct activation episode, target snapshot, the same sequence and evidence, expected head state, and idempotency identity.

`ActivePackHead` carries provider and stable pack identity, generation, publication epoch, hold state, latest accepted local sequence, active and previous snapshot identities, indexable summary, and activation time. Provider and collectible profiles use corresponding immutable snapshots and independent atomic heads.

`ActiveProviderProfileHead` and `ActiveCollectibleProfileHead` carry stable entity identity, generation, active and previous profile snapshot identities, content digest, and activation time. `SharedProviderChangeDelivery` carries organization, target provider, central change identity, immutable shared-dependency vector, bounded payload digest, lease identity, and acknowledgment identity.

`PublicationWorkState`, `PublicationOperationOutcome`, and `PublicationReasonCode` are shared by provider repositories, public-store receipts, operations status, alerts, and Admin labels. Every operation result includes its outcome and the resulting durable work state.

The authorization contract retains `providers:view` for organization-scoped read-only status and adds admin-only `pack_publication:recover`, `pack_catalog:launch`, and `pack_catalog:prune`. Automated publication uses separately scoped trusted service identities rather than an operator session.

The `pack_catalog_v1` read surface exposes `getPublicShellStatus`, `getDashboardBundle`, `listPublicPacks`, `getPublicPack`, `searchPublicCollectibles`, and `findPacksByDesiredCollectible`. `PackCatalogCursor` is opaque to clients and is accepted only by the query shape that issued it.

`SavedCatalogItemsV1` exposes authenticated `getSavedItemIds({})`, `setSavedRepack({ publicRepackId, saved })`, and `setSavedCollectible({ publicCollectibleId, saved })`. The read returns canonical ascending `savedRepackIds` and `savedCollectibleIds`, each bounded to 250. Each set operation returns `{ saved, prunedUnavailable }`; saving requires the corresponding current V1 head, removal does not, and no snapshot identity or client-supplied owner enters the contract.

## Acceptance Criteria

### Snapshot integrity

- [x] Updating pack A changes only pack A's snapshot and head; pack B's bytes and head remain unchanged.
- [x] Summary, detail, contents, odds, chase, valuations, actions, and EV validate against one snapshot identity.
- [x] Missing contents, invalid probabilities, stale dependencies, mismatched EV inputs, and protected fields cannot produce a completed snapshot.
- [x] A valid EV-unavailable fixture completes without a numeric EV, while technical calculation failure remains non-publishable.
- [x] First pack activation requires every named initial profile head, and later profile publication changes no existing pack snapshot hash.

### Identity, lifecycle, and ordering

- [x] Stable native pack and collectible IDs remain unchanged through update, rollback, lifecycle changes, saves, and direct links.
- [x] Availability mapping and explicit retirement fixtures remain readable; source omission or outage cannot retire a pack.
- [x] Only active-plus-available packs expose enabled purchase or promotion actions.
- [x] Local publication sequences order one provider's pack work, while provider and shared evidence remain separate identities.
- [x] Byte-identical artifacts reuse one snapshot identity while separate activation episodes retain distinct intent identities.

### Query and security contract

- [x] All six catalog queries resolve each included pack from exactly one active head and one complete snapshot.
- [x] Retirement-active plus availability-available defaults and explicit all-state queries return the declared lifecycle sets.
- [x] A signed cursor works only for its bound query and returns `CURSOR_EXPIRED` when expired, malformed, tampered, or used with changed query parameters.
- [x] A two-page activation race preserves valid keyset behavior and the documented live traversal semantics.
- [x] Wrong-scope operations and changed-byte replays fail closed without exposing protected data.

### Saved-item contract

- [x] Read and set operations derive one owner from authentication, use only stable public identities, and never store a snapshot identity.
- [x] Save, repeat, remove, missing-head, exact-capacity, stale-prune, invalid-ID, unauthenticated, and inconsistent-state fixtures return only the declared result or error shapes.
- [x] Pack and collectible save sets stay independently bounded to 250 and return canonical ascending identifiers.

### Authorization contract

- [x] Active admins and data operators with `providers:view` can read only sanitized status for their organization.
- [x] Only active admins with the exact named permission can authorize recovery, launch, or pruning, and none of those mutations is reachable through Admin.
- [x] Trusted service identities cannot cross their environment, organization, provider/catalog, entity, operation, or expiry scope.

## Spec Compliance

- **Related spec:** `pack-version-publication/tech-001`.
- **Alignment:** P01 adds the sole V1 contract modules, strict canonicalization, deterministic two-pack fixture, and the exact query, save, state, reason, and authorization vocabularies.
- **Divergences:** Review hardening binds cursor filters by a canonical SHA-256 digest instead of embedding them, with one 8,192-character wire bound. Snapshot identities add a verified summary digest; snapshot, active-head, and publication-envelope schemas require asynchronous parsing for cryptographic validation. PR #66 remains an extraction ledger; no runtime source was ported.
- **Later owners:** P02–P10 retain persistence, assembly runtime, fan-out, public storage/API, publication/recovery, frontend, operations, retention, and launch.
- **Evidence:** The named matrix (12 tests), contracts suite (431 tests), and full `verify:framework` gate pass. The local gate skips 66 opt-in database, capture, and tooling integration tests; the previously failing head-reconciliation regression also passes separately against disposable PostgreSQL with merged PR #85. Two inherited test-only lint/typecheck defects from `main` are corrected in a separate commit.

## Verification

Named scenario: **Native pack catalog contract matrix** — exercise two independent packs, profile prerequisites, every lifecycle and EV state, byte reuse, activation ordering, all six queries, cursor tampering, and protected-field rejection against the executable contract fixtures.
