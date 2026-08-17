# Task: Compose and Atomically Activate Catalog Manifests

**ID:** postgres-convex-promotion/010
**Depends on:** postgres-convex-promotion/009
**Blocks:** postgres-convex-promotion/011, postgres-convex-promotion/012, postgres-convex-promotion/013
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including public-read and pointer-safety verification
**Status:** done

## Start Here

Given active references A1/B1/C1, a completed A2, delayed B, and a settled disable for C, assemble and activate a manifest that references A2/B1, omits C, and changes no public result until its one compare-and-swap pointer mutation commits.

## Objective

Compose complete provider releases into one small immutable global manifest and expose their union through one atomic active-manifest pointer while preserving every existing public DTO and query outcome.

## Context

Provider completion must not be publicly visible. A manifest is the only catalog-wide consistency boundary: it names exactly one release for every enabled platform and makes the entire set active at once. Later manifests may advance one provider and reuse the others. The read model must compose provider-owned records into the same logical public V2 release users already consume.

## Requirements

### Manifest eligibility

- Store a bounded immutable manifest whose canonical sorted references contain exactly one complete provider release for every platform enabled by the settled PostgreSQL eligibility snapshot, with no disabled or duplicate platform.
- Treat the authenticated PostgreSQL manifest composer built in task `011` as the authority for the settled enabled-platform set and exhaustive cross-provider composition. Convex must verify the bounded signed manifest, provider completion proofs, configuration epoch, counts, hashes, ownership commitments, and compare-and-swap state without mirroring PostgreSQL eligibility or performing an unbounded activation-time entity scan.
- Require every reference to match its `platformKey`, shared configuration epoch, content proof, and completed state; reject mixed epochs, blocked releases, missing releases, and aggregate contract-limit overflow.
- Refuse the first active manifest until every enabled platform has complete backfill, settled affected derivations, and an eligible complete provider release.
- For a later ordinary provider delay, reuse only that platform's release from the current active manifest and mark it delayed; if an enabled platform has no active fallback, block activation.
- Remove a disabled platform only by activating a new manifest that omits it. Until that compare-and-swap succeeds, the prior manifest and provider remain publicly active.

### Public composition

- Validate the provider-release union as one deterministic public catalog: public IDs remain globally unique, repeated shared references are byte-identical, cross-record references resolve, aggregate counts/hashes reconcile, and global ordering is stable.
- Expose the current `DataReleaseMetadata`, public result/error schemas, repack/detail/search/facet behavior, opaque-cursor rules, and Heat attachment points without adding provider-release fields to public DTOs.
- Use the manifest's public content identity as the existing `publicReleaseId`; keep it stable when the referenced provider-release set and governing configuration are unchanged so metadata-only freshness refreshes do not expire cursors.
- Merge provider-local search data deterministically and fail the whole public read closed when any referenced release, count, hash, shared reference, or provider ownership proof is invalid.
- For collectible full-text search without type filters, issue one provider-release-filtered indexed query for each of the at most eight selected platforms. For the public multi-type OR filter, issue one release-and-type-filtered query per selected platform/type pair (at most eight platforms by the six supported types), then merge and rank the bounded candidates deterministically. Never query historical releases without a release filter or query an unfiltered type superset and then post-filter, because historical or excluded-type matches can hide active results. Task `014` must certify the bounded fan-out's hosted p95.
- Preserve the existing public limits and fail-closed `RELEASE_UNAVAILABLE`, not-found, invalid-query, and cursor-expired behavior.

### Activation and freshness

- Submit and activate the complete small manifest with one expected-active-manifest compare-and-swap that writes its terminal receipt and moves active/previous manifest pointers atomically.
- Keep manifests and provider releases immutable. When the provider-reference set is unchanged, refresh only monotonic active-state observation metadata instead of minting another manifest.
- Derive public freshness truthfully from every enabled provider: count a provider as delayed when its selected release checkpoint trails its latest affected settled/source head or its settled source state is delayed; make `freshness` delayed when that count is nonzero; and use the oldest applicable provider data-as-of, successful-observation, and stale-deadline value.
- Reject stale refreshes and preserve the prior active state on manifest assembly, validation, authentication, reconciliation, or compare-and-swap failure.
- Allow an explicitly authorized rollback only to a complete, unblocked manifest whose entire recorded enabled set, single configuration epoch, and provider references still validate, or to an explicitly authorized clear. A whole-manifest rollback may cross epochs but can never mix them, and it changes no provider completed head.

## User-Facing Behavior

Public queries switch from one complete provider set to another in one logical transition. A delayed provider keeps its previous catalog values and makes the existing freshness status delayed. Search, filters, details, errors, release-change pagination reset, and response shapes remain unchanged.

## Interface Contract

`GlobalCatalogManifestV1` contains a public manifest/release identity, shared configuration epoch, governing hashes, aggregate content/search hashes and counts, plus canonical references with `platformKey`, provider release identity, provider content hash, provider checkpoint, and provider data-as-of time.

`ActiveCatalogManifestState` contains active/previous manifest identities and monotonic aggregate observation/freshness metadata. It is the sole public activation authority.

Manifest publication exposes authenticated `activateManifest`, `status`, `refreshActiveState`, `rollback`, and `block` operations with exact request and terminal receipt digests. The complete bounded manifest is submitted to `activateManifest`; it has no multi-batch staging phase. The public read boundary resolves only `ActiveCatalogManifestState` and validates the full referenced set before returning the unchanged public contracts.

## Acceptance Criteria

### Manifest and pointer safety

- [x] Initial activation fails until every enabled platform has one eligible complete same-epoch provider release.
- [x] Later activation can select a new release for A, reuse delayed B's active release, and omit settled-disabled C in one atomic pointer change.
- [x] Missing, duplicate, disabled, wrong-platform, blocked, incomplete, mixed-epoch, or conflicting shared references fail without changing the active pointer.
- [x] Activation replay is idempotent, a stale expected-active manifest loses the compare-and-swap, and a lost response reconciles to one exact terminal result.

### Public compatibility and freshness

- [x] Existing public contract and frontend adapter tests pass without DTO, error, route, or query-input changes.
- [x] Cross-provider listing, sorting, search, facets, detail, desired-collectible matching, and cursor reset behave as one deterministic release.
- [x] Full-text search returns the correct global order at the eight-platform launch bound, rejects a ninth entry, and cannot be starved by otherwise better-ranked historical-release or excluded-type matches.
- [x] An unchanged provider-reference set refreshes freshness without changing immutable rows, manifest identity, public release identity, or valid cursors.
- [x] Delayed count and aggregate timestamps reflect the oldest selected provider facts and recover monotonically after that provider catches up.
- [x] Rollback and authorized clear preserve manifest-reference integrity and never mutate provider completed heads.

## Verification

`npm run test:contracts && npm run test:convex && npm run test:frontend && npm run typecheck:convex`
