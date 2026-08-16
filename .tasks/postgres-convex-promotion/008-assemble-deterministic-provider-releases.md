# Task: Assemble Deterministic Provider Releases

**ID:** postgres-convex-promotion/008
**Depends on:** postgres-convex-promotion/007
**Blocks:** postgres-convex-promotion/009, postgres-convex-promotion/011
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including deterministic rebuild and reuse verification
**Status:** not started

## Start Here

Assemble one platform fixture at a fixed provider checkpoint twice, then prove both runs produce the same provider-release identity, ordered records, hashes, and bounded batches without reading another platform's rows.

## Objective

Produce one immutable, sanitized catalog release for one configured platform at its own settled checkpoint, and reuse the existing release when that platform's public content is unchanged.

## Context

The completed assembler builds one organization-wide release and carries delayed vendors inside it. The approved architecture moves content ownership to a stable `platformKey`. Each provider release must be independently rebuildable from canonical PostgreSQL state, compatible with one shared configuration epoch, and complete enough for a later manifest to compose the unchanged public V2 view.

## Requirements

### Provider-owned content

- Assemble from one `ProviderCatalogCheckpoint` and exactly one stable `platformKey`; reject an unsettled, regressed, wrong-epoch, or caller-selected scope.
- Include that platform's public vendor, repacks, collectibles, chases, search data, and the governed category/reference projections required to validate those records.
- Exclude every other platform's provider-owned rows and all raw payloads, tenant identifiers, actors, credentials, internal run IDs, and quarantine detail.
- Require complete backfill, settled affected derivations, approved public identities, approved actions/origins, exact money and basis-point values, and valid references before classifying a provider release as ready.
- Preserve the existing treatment of disabled listings, sold-out listings, unavailable metrics, bounded reason codes, and deterministic dependency order.

### Identity, epoch, and reuse

- Bind every provider release to one shared public-configuration epoch plus the provider-scoped configuration inputs that affect its projection.
- Derive immutable content identity from the canonical public records and governing inputs, not from polling time, attempt identity, observation freshness, or unrelated providers.
- Classify same-epoch unchanged content as `reuse` and return the existing complete provider-release identity without minting or rewriting entity rows.
- Require a new compatible provider release after a shared configuration epoch changes, even when the provider's projected entity bytes are unchanged.
- Partition records into bounded, canonical batches with stable counts, per-kind hashes, batch hashes, and a complete rebuild equivalent to a change-triggered assembly.

## User-Facing Behavior

No provider release is directly public. Public DTO entities retain their current fields and semantics, and unchanged provider content does not force duplicate catalog rows.

## Interface Contract

`ProviderCatalogReleasePlanV1` returns `publish`, `reuse`, or `blocked` and includes:

- stable `platformKey`, shared configuration epoch, provider checkpoint, source watermark, and provider release identity;
- immutable content hash, governed dependency hashes, exact counts, provider-local search hash, and ordered bounded batches;
- provider data-as-of time plus separate successful-observation/freshness facts for later active-state aggregation;
- a stable blocked reason with no protected source data.

Shared reference projections may appear in more than one provider plan only when their public identity and canonical bytes are identical. Task `010` owns cross-release conflict rejection and the deduplicated public view.

## Acceptance Criteria

### Determinism and isolation

- [ ] Repeated assembly at one provider checkpoint produces byte-stable identity, hashes, counts, ordering, and batches.
- [ ] Platform A assembly reads and emits no provider-owned row from platform B.
- [ ] Full rebuild and change-triggered assembly at the same provider state produce identical public content.
- [ ] Missing identity, unsettled derivation, incomplete backfill, invalid reference, unapproved origin/action, or protected field fails closed.

### Reuse and compatibility

- [ ] Same-epoch unchanged content returns `reuse` with the existing complete provider-release identity and no new immutable rows.
- [ ] A shared configuration epoch change refuses reuse of a release from the prior epoch.
- [ ] Provider-local batches stay within contract limits and reconcile to the exact provider release hash and counts.
- [ ] Every emitted entity still validates against the existing public V2 entity contracts.

## Verification

`npm run test:contracts && npm run test:database && npm run test:services`
