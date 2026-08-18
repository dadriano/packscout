# Convex Frontend Data Model

Status: canonical frontend-serving model

Convex stores a versioned, post-processed PackScout read model. It does not
store provider stream envelopes, raw provider payloads, ingestion cursors,
pull histories, market-event histories, proprietary calculation inputs, or
pipeline recovery state. PostgreSQL and pipeline-owned storage remain
authoritative for those records.

## Entity relationship view

```text
PROVIDER_CATALOG_COMPLETED_HEADS ───────────────┐
  one independently completed head per platform │
                                                ▼
ACTIVE_CATALOG_MANIFEST_STATE          PROVIDER_CATALOG_RELEASES
  activeManifestId  ────────────┐        immutable, platform-owned
  previousManifestId ─────────┐ │                 ▲
  aggregate observation       │ │                 │
                              ▼ ▼                 │
                    GLOBAL_CATALOG_MANIFESTS      │
                      bounded provider graph      │
                              │                   │
                              ▼                   │
              CATALOG_MANIFEST_PROVIDER_REFERENCES
                              │
                              └───────────────────┘

PROVIDER_CATALOG_RELEASES
  ├── PROVIDER_CATALOG_VENDORS
  ├── PROVIDER_CATALOG_CATEGORIES
  ├── PROVIDER_CATALOG_REPACKS ────────────┐
  ├── PROVIDER_CATALOG_COLLECTIBLES ────┐  │
  ├── PROVIDER_CATALOG_REPACK_CHASES ◀──┴──┘
  └── PROVIDER_CATALOG_SEARCH_SHARDS

ACTIVE_CATALOG_MANIFEST_STATE ──▶ active GLOBAL_CATALOG_MANIFEST
                                            │ exact manifest alignment
                                            ▼
REPACK_HEAT_STATE ──────────────▶ REPACK_HEAT_SNAPSHOTS
  active + previous                       │
                                         ▼
                              REPACK_HEAT_SIGNAL_SETS
                                         │
                                         ▼
                              REPACK_HEAT_SIGNALS
                                │ provider release + repack
                                └─────────────▶ PROVIDER_CATALOG_REPACKS
```

Every public entity belongs to exactly one immutable provider release. A
provider's completed head is not public by itself. Public queries first resolve
one complete active global manifest, validate its canonical provider-reference
graph, and then compose only the selected releases. One response therefore
never combines a provider release outside the active manifest or releases from
different configuration epochs.

## Field-level text ERD

```text
providerCatalogCompletedHeads
  _id
  platformKey
  releaseId             -> providerCatalogReleases._id
  publicProviderReleaseId
  sharedConfigurationEpoch, providerCheckpoint, observation
  terminal operation kind/ID and terminal receipt SHA

providerCatalogReleases
  _id
  platformKey
  publicProviderReleaseId
  lifecycle
  sharedConfigurationEpoch, dataAsOf
  providerReleaseFingerprint, contentHash
  governingHashes, entityHashes, counts
  publicAssetOrigins, search algorithm/index hash
  batch count/chain hash, completion proof, retention boundary

providerCatalogVendors
  _id
  releaseId             -> providerCatalogReleases._id
  publicVendorId
  vendorKey
  detail                (name, public logo/site, approved hosts/origins/promo)

providerCatalogCategories
  _id
  releaseId             -> providerCatalogReleases._id
  publicCategoryId
  parentCategoryId?     -> providerCatalogCategories._id
  categoryKey
  detail                (name, kind, depth, canonical ancestor path)

providerCatalogRepacks
  _id
  releaseId             -> providerCatalogReleases._id
  publicRepackId
  vendorId              -> providerCatalogVendors._id
  detail                (offer, classifications, both EVs, content summary)

providerCatalogCollectibles
  _id
  releaseId             -> providerCatalogReleases._id
  publicCollectibleId
  collectibleType
  normalizedName
  searchText
  detail                (identity, aliases, type, categories, valuation, image)

providerCatalogRepackChases
  _id
  releaseId             -> providerCatalogReleases._id
  repackId              -> providerCatalogRepacks._id
  collectibleId         -> providerCatalogCollectibles._id
  detail                (role, evidence, probability, match confidence)

providerCatalogSearchShards / providerCatalogSearchShardProofs
  _id
  releaseId             -> providerCatalogReleases._id
  shard number, row/byte counts, content hash
  rows[]                (bounded provider-scoped search/filter/sort projection)

providerCatalogPublications / providerCatalogBatches
  _id
  releaseId             -> providerCatalogReleases._id
  exact platform/checkpoint/observation and expected completion head
  accepted reconciliation state and bounded batch chain

providerCatalogOperations
  _id
  platformKey, publicProviderReleaseId?
  operation identity, kind, idempotency/body hash, status/result, exact receipt

providerCatalogReleaseCompletionProofs / providerCatalogTerminalReceiptProofs
  _id
  releaseId             -> providerCatalogReleases._id
  bounded immutable finalize/reuse proof and terminal receipt digest

providerCatalogReleaseBlocks
  _id
  platformKey, providerReleaseFingerprint, blockSequence
  stable reason, originating operation, terminal receipt proof

globalCatalogManifests
  _id
  publicReleaseId       (existing public catalog identity)
  manifestFingerprint, providerReferenceSetHash
  manifest              (same-epoch canonical provider references,
                         governing/composition/entity hashes and counts)
  providerReleaseIds[]  -> providerCatalogReleases._id (bounded to eight)
  lifecycle, creation and retention boundary

catalogManifestProviderReferences
  _id
  manifestId            -> globalCatalogManifests._id
  releaseId             -> providerCatalogReleases._id
  platformKey, public provider release ID, both fingerprints

activeCatalogManifestState
  _id
  key = "singleton"
  generation
  activeManifestId?     -> globalCatalogManifests._id
  previousManifestId?   -> globalCatalogManifests._id
  active/previous bounded manifest pointers
  aggregate observation (selected providers, watermarks, global freshness)
  terminal operation and receipt proof

catalogManifestOperations / catalogManifestBlocks
  exact activation, refresh, rollback, clear, and block receipts/proofs

catalogRetentionState / catalogRetentionOperations
  generation-CAS reference audit and bounded manifest/provider cleanup receipts

dataReleaseAuthNonces
  shared authenticated-publication replay defense; preserved across cutover

repackHeatState
  _id
  key = "singleton"
  activeHeatSnapshotId? -> repackHeatSnapshots._id
  previousHeatSnapshotId? -> repackHeatSnapshots._id
  freshness            (current | expired | unavailable)
  expiresAt?            (must match the active snapshot)
  latestSequence, updatedAt

repackHeatSnapshots
  _id
  manifestId            -> globalCatalogManifests._id
  manifestAlignment     (public manifest identity, fingerprint,
                         configuration epoch, provider-reference-set hash)
  signalSetId           -> repackHeatSignalSets._id
  publicHeatSnapshotId  (temporal frame/publication identity)
  publicationId?        (required for observed production frames)
  simulationRunId?      (required only for simulated frames)
  sequence, sourceWatermark?, lifecycle, sourceKind
  scenarioVersion?      (required only for simulated frames)
  aggregationVersion, heatPolicyVersion, contentHash
  signalCount
  baselineWindowStartedAt, baselineWindowEndedAt
  currentWindowStartedAt, currentWindowEndedAt
  calculatedAt, expiresAt

repackHeatSignalSets
  _id
  manifestId            -> globalCatalogManifests._id
  manifestAlignment     (exact active manifest/provider set)
  signalSetHash         (content address over temporal-free signal cores)
  lifecycle, sourceKind, scenarioVersion?
  aggregationVersion, heatPolicyVersion, signalCount
  originatingPublicationId?, createdAt, completedAt?, retentionEligibleAt?

repackHeatSignals
  _id
  signalSetId           -> repackHeatSignalSets._id
  providerReleaseId     -> providerCatalogReleases._id
  repackId              -> providerCatalogRepacks._id
  publicRepackId
  detail                (bounded temporal-free public aggregate core)

repackHeatPublications / repackHeatBatches / repackHeatOperations
  manifest-bound staged frame, bounded batch reconciliation, and exact receipts
  never contain organization, internal provider identity, actor, credential,
  tenant, or raw source fields
```

Convex document IDs provide table-aware references, not SQL foreign keys or
cascades. Provider finalization proves uniqueness, provider ownership, complete
references, counts, hashes, and exact receipts without changing public state.
Manifest activation then proves the same configuration epoch, enabled-platform
set, shared-reference byte agreement, aggregate graph, and expected active
pointer before one compare-and-swap exposes the selected provider union.

## Product entities

### Vendors (`providerCatalogVendors`)

One frontend-safe vendor identity and its approved public presentation and
action configuration. A vendor has many repacks within its provider release.

### Categories (`providerCatalogCategories`)

A normalized hierarchy such as `Sports → Basketball → NBA` or
`Trading cards → Pokémon`. Parent and ancestor identifiers make hierarchy
resolution deterministic. A published repack materializes the complete path
for every assigned leaf category, so an NBA repack is searchable and
filterable as Trading Cards, Sports, Basketball, or NBA. Ancestors on that
single path do not make it mixed. Physical collectible type is modeled
separately.

### Repacks (`providerCatalogRepacks`)

One display-ready repack or gacha aggregate. It includes the current offer,
availability, category and collectible-type classification, bounded content
summary, separate EV estimates, approved actions, media, and freshness.

`contentMode` is:

- `focused` for one independent category branch and collectible type;
- `mixed` for multiple independent category branches or collectible types;
- `unknown` when published evidence is insufficient.

An ancestor and descendant on the same branch do not make a repack mixed.

The source provider's mutable `catalog` records map into these aggregate
entities during pipeline processing. The stream name is intentionally absent
from this public model: pack-like records become repacks, item-like records
become collectibles, vendor-specific category evidence becomes normalized
category relationships, and derived metrics become release-scoped projections.

### Collectibles (`providerCatalogCollectibles`)

Normalized, searchable chase identities. The table supports cards, watches,
coins, sealed products, memorabilia, and other collectible types. Searchable
identity fields are bounded and public; raw source records and internal
identity-resolution evidence are excluded.

### Repack chases (`providerCatalogRepackChases`)

The many-to-many relationship between repacks and collectibles. It records the
role, public evidence classification, optional probability and valuation, and
chase-match confidence. A collectible can therefore match multiple repacks,
and a repack can expose multiple known or inferred chases without embedding an
unbounded array.

## EV estimates

Each repack keeps two independent estimates:

```text
evEstimates
├── vendorReported
│   ├── status and original displayMoney
│   ├── normalized comparison metrics, when available
│   ├── observedAt
│   └── reason, when comparison is unavailable
└── packScout
    ├── status and normalized metrics
    ├── confidence
    │   ├── scoreBasisPoints
    │   ├── band
    │   └── limitationCodes[]
    ├── modelVersion
    ├── confidencePolicyVersion
    ├── dataAsOf
    └── calculatedAt
```

Vendor-reported EV and PackScout EV are never averaged, substituted, or
silently reconciled. Dashboard rankings and opportunity counts use PackScout
EV explicitly. PackScout confidence measures estimate reliability, not whether
the EV is positive.

Vendor source money remains displayable even when PackScout cannot normalize it
into comparable USD metrics. That preserves what the vendor actually reported
without treating an unsupported currency or missing repack price as zero.
Sanitized non-ISO codes such as `USDC` use a bounded code-plus-amount display
instead of being passed to an ISO currency formatter.

Chase-match confidence is a separate field on
`providerCatalogRepackChases`; it expresses how certain PackScout is that a
collectible can occur in a repack.

## Repack heat boundary

Heat is a mutable, manifest-aligned read projection next to the immutable
provider releases and global manifests; it is not part of any provider release
or manifest content hash. Immutable, content-addressed signal sets hold only
temporal-free aggregate cores. Each signal set and frame carries the active
manifest's public identity, fingerprint, shared configuration epoch, and exact
provider-reference-set hash. Temporal frame envelopes also hold the settled
source watermark, closed minute, 24-hour baseline, 15-minute current window,
calculation time, and 15-minute expiry. Public reads hydrate the existing signal
DTO from those records. Heat never substitutes for vendor-reported EV or
PackScout modeled EV.

Public reads first resolve `repackHeatState`, then require one complete active
snapshot whose manifest alignment exactly matches
`activeCatalogManifestState`. Each signal must point to a provider release and
repack selected by that manifest and must match the snapshot timestamps, policy,
source kind, aggregation version, and simulated scenario when applicable.
Missing, malformed, cross-manifest, unselected-provider, or otherwise
misaligned Heat degrades to an unavailable Heat wrapper while the valid catalog
remains readable. Explicitly expired state returns an expired wrapper without a
signal. Queries do not use wall-clock time to infer freshness because cached
Convex queries do not rerun merely as time passes. Freshness is materialized by
the ID-bound scheduled expiry; already-open browser views also stop presenting
a current signal at its explicit deadline.

Production publishing uses authenticated private `active-state`, `start`,
`apply-batch`, `finalize`, `status`, `refresh-frame`, and `retain` endpoints
under `/internal/repack-heat/v1/`. Changed signal content stages at most 100
records and 48 KiB per batch, reconciles exactly one valid signal for every
repack selected by the active manifest, and changes the pointer only in the
successful finalize transaction. Finalize rechecks the expected active manifest
and expected active Heat frame, so a manifest change, concurrent publisher, or
restart cannot expose a frame for the wrong provider set or overwrite a newer
frame. Exact operation replay returns the stored receipt; conflicting reuse
fails closed.

Every frame sequence equals its closed UTC minute. Frame sequence, all window
boundaries, calculation time, expiry, and active frame identity strictly
advance. The settled source watermark never decreases; equality is expected
during quiet minutes. `refresh-frame` can reuse any completed immutable signal
set for the same manifest alignment, including A → B → A, without rewriting
signal documents. The active-state probe returns an exact canonical
terminal-receipt SHA only when the Heat and manifest pointers remain aligned,
which lets a fresh durable runner prove bootstrap state without adopting an
unknown remote frame.

Activation schedules an expiry mutation bound to the exact frame ID and
`expiresAt`. At the 15-minute boundary it materializes expired state and
reactively invalidates public queries even when the PostgreSQL worker is down;
a delayed callback for an older frame cannot expire its successor. Queries do
not read the wall clock. Hourly retention preserves active and previous frames
and their proving terminal receipts, deletes retired frames and unreferenced
signal sets after seven days, and removes abandoned staging data after its
unactivatable frame expires.

`PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` is a JSON object keyed by active key ID.
Each value is canonical padded base64 for 32–256 opaque secret bytes, matching
the worker's `PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64`; values are decoded
before HMAC-SHA256 import and are never stored in Convex documents. Rotate by
adding the new key ID and base64 secret to the map, deploying workers with the
new key ID, then removing the retired entry only after the authentication and
nonce windows have elapsed.

Provider-release publishing additionally requires
`PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS`, a strict JSON object mapping each
provider publisher key ID to exactly one canonical `platformKey`. Convex passes
the authenticated key ID—not a caller-supplied authority field—to every
provider-release mutation and rejects a request whose platform does not match
that server-side binding. Multiple key IDs may temporarily map to the same
platform during a key rotation. The binding map contains no secrets and is
never returned in receipts or errors.

### Local simulation lifecycle

The temporary simulator is deliberately outside Convex:

```text
explicit seed + startAt + frame + scenario step + publication cadence
  -> deterministic synthetic activity in local Node memory
  -> pure heat calculator
  -> canonical bounded aggregate frame
  -> guarded internal Convex publisher
  -> current/expired public heat wrappers
```

Synthetic raw activity, outcome keys, and pull histories are discarded after
projection and are never mutation arguments or Convex documents. The publisher
requires both the exact local runtime and its temporary enable flag, an active
complete mock catalog manifest, complete signal coverage for its selected
provider releases, exact manifest alignment, and canonical hashes.
The local script independently refuses cloud deploy keys, non-loopback URLs,
self-hosted selection, and non-local deployments. The scheduled expiry requires
the exact local mock manifest and snapshot binding but not the temporary flag,
so the script can always remove that flag immediately after one-shot
publication.

The default current window is 15 minutes and the baseline window is 24 hours.
One-shot resolves `startAt` once to the current time and is the command default.
Looping must be requested explicitly. The development launcher publishes every
five wall-clock seconds; this cadence advances public evidence timestamps,
while `frameStepMilliseconds` independently advances the deterministic scenario
profile by five minutes. Publication cadence is part of run identity, so direct
frame selection remains byte-reproducible. Each frame has a 15-minute TTL, and
the launcher marks the last frame expired during shutdown. Supervised npm/npx
children run in their own process groups with bounded graceful shutdown and a
SIGKILL fallback, preventing backend or frontend grandchildren from being left
behind.

## Desired-chase search

```text
search phrase
  → resolve active global manifest
  → release-filtered PROVIDER_CATALOG_COLLECTIBLES search per selected provider
  → validate and deterministically merge identical shared identities
  → selected publicCollectibleId
  → PROVIDER_CATALOG_REPACK_CHASES by each owning release + collectible
  → point-load selected-release PROVIDER_CATALOG_REPACKS
  → return match evidence, chase confidence, and both EV estimates
```

The exact collectible selection is included in pagination/query identity when
it filters the main repack list. Changing the desired collectible resets the
cursor. Generic repack search remains a bounded projection in
`providerCatalogSearchShards` for each manifest-selected provider release.

## Release infrastructure

- `providerCatalogReleases` stores immutable, platform-owned content and proof.
  Its entity, shard, reconciliation, batch, publication, operation, and bounded
  terminal-proof tables let one provider complete independently. The separate
  `providerCatalogCompletedHeads` row advances on finalize or unchanged reuse;
  completion has no public side effect.
- `globalCatalogManifests` stores one immutable, same-configuration-epoch
  provider graph. `catalogManifestProviderReferences` is its independently
  auditable edge index; every public and retention read compares those edges
  with the manifest's embedded canonical references.
- `activeCatalogManifestState` is the only public catalog pointer. One
  expected-generation/expected-active-manifest compare-and-swap moves active to
  previous and exposes the new provider union atomically. Its aggregate
  observation may refresh truthful freshness without minting a new manifest or
  invalidating same-manifest cursors.
- `providerCatalogReleaseBlocks` and `catalogManifestBlocks` prevent a rejected
  immutable artifact from becoming eligible. `catalogManifestOperations`
  stores exact activation, refresh, block, rollback, and clear receipts.
- `catalogRetentionState` and `catalogRetentionOperations` protect the complete
  manifest-to-provider graph and coordinate bounded generation-CAS deletion.
  `dataReleaseAuthNonces` remains the shared request-replay defense; it is not a
  catalog source of truth.

Convex indexes are lookup indexes rather than uniqueness constraints. The
provider publisher must reconcile identifiers, single-provider ownership,
hierarchy, hashes, counts, materialized metrics, every shard, and the canonical
provider shard-index hash before completion. The manifest composer then proves
the enabled-platform set, same epoch, unique vendor/repack ownership, identical
bytes for repeated shared categories and collectibles, aggregate hashes/counts,
origin policy, and cross-reference graph. Public reads fail closed when any
stored release, edge, shard, or aggregate proof diverges.

The active manifest supports at most eight provider references and 8,000
repacks in aggregate. Provider search shards hold at most 32 rows and 48 KiB
each, and the aggregate manifest contains at most 250 shards. The sum of
physical category copies across selected providers is capped at 4,096 so shared
identity validation remains exhaustive. One collectible occurrence may relate
to at most 500 repacks in its provider release. Untyped collectible search runs
one release-filtered query per selected provider; the six-value typed OR filter
runs at most 48 release-and-type-filtered queries. Results are bounded,
validated, deduplicated only when shared public bytes agree, and merged
deterministically.

Canonical publication therefore has two gates. Provider finalization recomputes
provider content, configuration, batch-body, shard, and shard-index hashes and
persists a bounded completion proof. Manifest activation recomputes the
canonical provider reference set, composition graph, global content/search
hashes and counts, compares `originSetHash` with the deployment-approved value,
and rechecks every selected terminal receipt. A missing provider receipt or
deployment hash leaves the prior manifest readable.

The production manifest and Heat publisher/finalizer boundaries both stage,
reconcile, authenticate, and atomically activate independent pointers. Heat
additionally binds the exact active manifest and provider set, so catalog
activation never waits for Heat but wrong-manifest Heat is unavailable. The
development-only mock seed independently recomputes complete provider releases,
the manifest graph, and projection hashes before writing.

## Cutover and deployment boundary

This is a clean prelaunch replacement. Runtime code does not read or write the
obsolete single-release catalog tables and does not translate them into provider
releases or manifests. There are no aliases, compatibility tables, dual reads,
dual writes, or optional legacy Heat fields.

In an approved preproduction cutover, stop all publication workers and run the
target-bound reset in the
[promotion runbook](postgres-convex-promotion-runbook.md) before PostgreSQL
migration `20260816030000_heat_manifest_alignment` and before this Convex
schema is deployed. The reset takes a verified deployment-wide Convex export,
clears the closed obsolete catalog and pre-manifest Heat table allowlists,
preserves `dataReleaseAuthNonces`, and deletes only the target-bound obsolete
PostgreSQL `catalog`/`heat` promotion ledger. It proves canonical history,
causal settlement, approved configuration, governed mappings, and normalized
Heat are unchanged.

After the migration and schema deploy, authenticated bootstrap must prove empty
provider, manifest, retention, and Heat publication state before claims begin.
Any existing provider-manifest document, observed production data, second
organization, missing backup, or alignment mismatch is a cutover stop—not
permission to purge, seed mock data, or add compatibility behavior. The
development mock seed creates only the provider releases, manifest graph, and
manifest-aligned Heat entities described above and remains guarded from
production use.
