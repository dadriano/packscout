# Convex Frontend Data Model

Status: canonical frontend-serving model

Convex stores a versioned, post-processed PackScout read model. It does not
store provider stream envelopes, raw provider payloads, ingestion cursors,
pull histories, market-event histories, proprietary calculation inputs, or
pipeline recovery state. PostgreSQL and pipeline-owned storage remain
authoritative for those records.

## Entity relationship view

```text
DATA_RELEASE_STATE
  activeReleaseId  ───────────────┐
  previousReleaseId ────────────┐ │
                                 ▼ ▼
                         DATA_RELEASES
                         │ release metadata and counts
                         │
        ┌────────────────┼───────────────┬────────────────┐
        ▼                ▼               ▼                ▼
     VENDORS         CATEGORIES       REPACKS        COLLECTIBLES
        │                │               │                │
        │                └──────┐        │                │
        └───────────────────────┼────────┘                │
                               │                         │
                               ▼                         │
                       REPACK_CHASES ◀────────────────────┘
                               │
                               │ desired-collectible lookup
                               ▼
                       matching REPACKS

DATA_RELEASES ───────────────▶ REPACK_SEARCH_SHARDS
DATA_RELEASES ───────────────▶ DATA_RELEASE_BATCHES
DATA_RELEASES ───────────────▶ DATA_RELEASE_OPERATIONS

DATA_RELEASES ──────────────▶ REPACK_HEAT_SNAPSHOTS
REPACK_HEAT_STATE ──────────▶ active + previous REPACK_HEAT_SNAPSHOTS
REPACK_HEAT_SNAPSHOTS ──────▶ REPACK_HEAT_SIGNALS ─────▶ REPACKS

PRIVY IDENTITY ─────────────▶ SAVED_REPACKS ────────────▷ REPACKS
PRIVY IDENTITY ─────────────▶ SAVED_COLLECTIBLES ───────▷ COLLECTIBLES
```

Every public entity belongs to exactly one immutable data release. Public
queries resolve the active release first, so one response never combines
entities from different releases.

## Field-level text ERD

```text
dataReleaseState
  _id
  key = "singleton"
  activeReleaseId?      -> dataReleases._id
  previousReleaseId?    -> dataReleases._id
  dataAsOf, staleAt, freshness, delayedVendorCount

dataReleases
  _id
  publicReleaseId
  lifecycle
  metadata              (schema, hashes, counts, policy versions, freshness)
                        includes repackSearchIndexHash
  searchShardCount

vendors
  _id
  releaseId             -> dataReleases._id
  publicVendorId
  vendorKey
  detail                (name, public logo/site, approved hosts/origins/promo)

categories
  _id
  releaseId             -> dataReleases._id
  publicCategoryId
  parentCategoryId?     -> categories._id
  categoryKey
  detail                (name, kind, depth, canonical ancestor path)

repacks
  _id
  releaseId             -> dataReleases._id
  publicRepackId
  vendorId              -> vendors._id
  detail                (offer, classifications, both EVs, content summary)

collectibles
  _id
  releaseId             -> dataReleases._id
  publicCollectibleId
  collectibleType
  normalizedName
  searchText
  detail                (identity, aliases, type, categories, valuation, image)

repackChases
  _id
  releaseId             -> dataReleases._id
  repackId              -> repacks._id
  collectibleId         -> collectibles._id
  detail                (role, evidence, probability, match confidence)

repackSearchShards
  _id
  releaseId             -> dataReleases._id
  shardNumber
  rows[]                (bounded repack search/filter/sort projection)

dataReleaseBatches
  _id
  releaseId             -> dataReleases._id
  batchIndex, kind, idempotencyKey, bodyHash, counts

dataReleaseOperations
  _id
  publicReleaseId?      -> dataReleases.publicReleaseId (logical)
  operationId, kind, idempotencyKey, status, result, receipts

blockedDataReleaseManifests
  _id
  fingerprint           -> dataReleases.metadata.manifestFingerprint (logical)
  originatingOperationId -> dataReleaseOperations.operationId (logical)
  active, reason, timestamps, release receipt

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
  releaseId             -> dataReleases._id
  publicHeatSnapshotId  (content-bound public identity)
  simulationRunId?      (required only for simulated frames)
  sequence, lifecycle, sourceKind
  scenarioVersion?      (required only for simulated frames)
  aggregationVersion, heatPolicyVersion, contentHash
  signalCount
  baselineWindowStartedAt, baselineWindowEndedAt
  currentWindowStartedAt, currentWindowEndedAt
  calculatedAt, expiresAt

repackHeatSignals
  _id
  heatSnapshotId        -> repackHeatSnapshots._id
  releaseId             -> dataReleases._id
  repackId              -> repacks._id
  publicRepackId
  detail                (bounded public heat aggregate and evidence components)

savedRepacks
  _id
  ownerTokenIdentifier  (verified Convex auth identity; never client supplied)
  publicRepackId         -> repacks.publicRepackId (stable logical reference)

savedCollectibles
  _id
  ownerTokenIdentifier  (verified Convex auth identity; never client supplied)
  publicCollectibleId    -> collectibles.publicCollectibleId (stable logical reference)
```

Convex document IDs provide table-aware references, not SQL foreign keys or
cascades. Release finalization code is responsible for uniqueness, same-release
ownership, complete references, and count/hash reconciliation before changing
the active pointer.

Saved-item references deliberately use stable public IDs instead of release-
scoped Convex document IDs. They can survive an immutable release swap and
resolve again when the same public entity appears in a later release.

## Product entities

### `vendors`

One frontend-safe vendor identity and its approved public presentation and
action configuration. A vendor has many repacks within a release.

### `categories`

A normalized hierarchy such as `Sports → Basketball → NBA` or
`Trading cards → Pokémon`. Parent and ancestor identifiers make hierarchy
resolution deterministic. A published repack materializes the complete path
for every assigned leaf category, so an NBA repack is searchable and
filterable as Trading Cards, Sports, Basketball, or NBA. Ancestors on that
single path do not make it mixed. Physical collectible type is modeled
separately.

### `repacks`

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

### `collectibles`

Normalized, searchable chase identities. The table supports cards, watches,
coins, sealed products, memorabilia, and other collectible types. Searchable
identity fields are bounded and public; raw source records and internal
identity-resolution evidence are excluded.

### `repackChases`

The many-to-many relationship between repacks and collectibles. It records the
role, public evidence classification, optional probability and valuation, and
chase-match confidence. A collectible can therefore match multiple repacks,
and a repack can expose multiple known or inferred chases without embedding an
unbounded array.

## Authenticated saved items

`savedRepacks` and `savedCollectibles` are the first durable, user-owned Convex
tables. They are outside the immutable release graph and must never be deleted,
reseeded, or replaced by catalog publication and local mock-release utilities.
The catalog remains publicly readable without authentication.

Ownership comes only from `ctx.auth.getUserIdentity().tokenIdentifier` after
Convex verifies a Privy access token. Public mutations do not accept an owner or
user ID from the browser. Each owner can save at most 250 repacks and 250 exact
collectibles. Saving requires the public ID to resolve exactly once in the
active complete release; removing a save remains possible even if that entity
is no longer in the active release. Repeated save and remove requests are
idempotent. When a kind is already at capacity, saving a new active entity
removes only the owner's oldest unavailable save of that same kind, with public
ID as the deterministic tie-break, and tells the browser that capacity recovery
occurred. If every saved entity remains active, the mutation refuses the new
save instead. No capacity path crosses owners or collectible/repack kinds.

These tables change the operational meaning of the Convex deployment: catalog
data is rebuildable, but account saves are not. Backup, export, account deletion,
privacy requests, environment separation, and destructive local/live tooling
must treat saved-item rows as durable user data. The Privy app ID is public
configuration; no Privy app secret or access token belongs in a document, log,
telemetry event, or client-provided ownership field.

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

Chase-match confidence is a separate field on `repackChases`; it expresses how
certain PackScout is that a collectible can occur in a repack.

## Repack heat boundary

Heat is a mutable, release-aligned read projection next to the immutable catalog;
it is not part of the catalog release hash. Each signal keeps observed activity,
observed return, large-hit frequency, chase availability, and pool-composition
components separate. It also carries its current and baseline windows, sample
requirements, limitations, provenance, policy version, calculation time, and
expiry. Heat never substitutes for vendor-reported EV or PackScout modeled EV.

Public reads first resolve `repackHeatState`, then require one complete active
snapshot for the same active catalog release. Each signal must match its repack,
snapshot timestamps, policy, source kind, aggregation version, and simulated
scenario when applicable. Missing, malformed, cross-release, or misaligned heat
degrades to an unavailable heat wrapper while the valid catalog remains
readable. Explicitly expired state returns an expired wrapper without a signal.
Queries do not use wall-clock time to infer freshness because cached Convex
queries do not rerun merely as time passes. Freshness is materialized by the
ID-bound scheduled expiry; already-open browser views also stop presenting a
current signal at its explicit deadline.

Publishing a current frame atomically advances the heat pointer and retains at
most the current and previous snapshots. Frames must be canonical, not already
expired, within the publish-lag/future-skew policy, and bounded by the policy
TTL. Every frame strictly advances the active baseline window, current window,
calculation time, and expiry even when a new simulation run starts. The public
snapshot ID is derived from the aggregate frame hash: an exact replay is
unchanged, while the same ID with different content is a conflict. Sequence
gaps and unsorted or duplicate signal identities fail before writes. Publishing
also schedules an expiry operation bound to the exact snapshot ID and expected
`expiresAt`; a stale job cannot expire a newer frame.

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
complete mock catalog release, complete signal coverage, and canonical hashes.
The local script independently refuses cloud deploy keys, non-loopback URLs,
self-hosted selection, and non-local deployments. The scheduled expiry requires
the exact local mock release and snapshot binding but not the temporary flag, so
the script can always remove that flag immediately after one-shot publication.

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
  → active-release COLLECTIBLES search
  → selected publicCollectibleId
  → REPACK_CHASES by releaseId + collectibleId
  → point-load active-release REPACKS
  → return match evidence, chase confidence, and both EV estimates
```

The exact collectible selection is included in pagination/query identity when
it filters the main repack list. Changing the desired collectible resets the
cursor. Generic repack search remains a bounded projection in
`repackSearchShards`.

## Release infrastructure

- `dataReleaseState` atomically points to the active and retained release.
- `dataReleases` stores immutable public release metadata, hashes, counts, and
  freshness.
- `repackSearchShards` provides bounded general search, facets, and sorting.
- `dataReleaseBatches` and `dataReleaseOperations` provide idempotent
  publication receipts without exposing pipeline internals to public queries.
  Each batch receipt hashes its own kind and canonical body.
- `blockedDataReleaseManifests` mirrors the authoritative pipeline block set
  for publication safety.

Convex indexes are lookup indexes rather than uniqueness constraints. The
publisher must reconcile identifiers, release ownership, hierarchy, hashes,
counts, and materialized metrics before a release can become active.
Every shard is hashed individually, and the canonical shard descriptor set is
anchored by `dataReleases.metadata.repackSearchIndexHash`; public reads fail
closed when either layer diverges.

The public contract supports at most 8,000 repacks per release. Search shards
hold at most 32 rows and 48 KiB each; these coordinated limits keep the complete
facet/sort projection inside the bounded Convex read path. One collectible may
relate to at most 500 published repacks, which bounds exact-chase lookups before
the requested page is hydrated.

Canonical publication requires a separate activation gate that recomputes the
release content, configuration, manifest, batch-body, shard, and shard-index
hashes; reconciles all counts and references; and compares `originSetHash` with
the deployment-approved origin-set hash. Public reads already fail closed for a
canonical release when that deployment hash is absent or does not match.

The production publisher/finalizer that performs the full canonical activation
gate is not implemented by this frontend-serving schema slice. Canonical
publication therefore remains blocked until that pipeline-owned boundary is
delivered and verified. The development-only mock seed independently
recomputes its complete release and projection hashes before writing.

## Cutover and deployment boundary

This is a clean V2 replacement. Runtime code does not read or write the former
snapshot/pack tables and does not translate V1 records. Existing documents in
an older Convex deployment may remain physically present after the new schema
is pushed because removing a table declaration is not a data-deletion request;
they are dormant because no V2 function references them.

Do not purge those documents as part of an application deploy. Back up and
remove them only through a separately approved, environment-scoped cleanup
after a V2 release has been published, activated, and read back successfully.
The development mock seed creates only the V2 entities described above and is
guarded from production use.
