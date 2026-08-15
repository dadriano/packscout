# Task: Assemble Deterministic Catalog Releases

**ID:** postgres-convex-promotion/002
**Depends on:** postgres-convex-promotion/001
**Blocks:** postgres-convex-promotion/004
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including export fixtures and rebuild equivalence
**Status:** done

## Start Here

Assemble one two-vendor release fixture at a fixed settled watermark and prove that repeated assembly produces the same manifest and ordered batch content.

## Objective

Produce one sanitized, deterministic catalog release from PostgreSQL at a settled causal watermark using the existing strict public V2 contract.

## Context

Convex already has a public release schema and fail-closed queries, but production has no canonical assembler. The runner must export a coherent point-in-time release rather than mirror changed rows. Determinism is required for idempotency, unchanged-content refresh, full rebuild equivalence, and safe reconciliation after lost acknowledgements.

## Requirements

- Assemble from the highest requested settled watermark only; reject an unsettled or regressed watermark.
- Resolve the approved PackScout organization and an approved, versioned public configuration server-side.
- Include all enabled-provider data for the first activation only after complete backfill and settled derived work are proven.
- For later releases, retain the last settled public projection for a delayed provider and report a truthful `delayedVendorCount` rather than publishing a partial vendor view.
- Produce the existing strict V2 manifest and public entities with canonical ordering, stable public identities, exact integer money/basis-point values, bounded reason codes, approved action/media origins, and reference integrity.
- Exclude disabled listings; include sold-out listings as non-actionable.
- Exclude raw payloads, tenant identifiers, actor data, credentials, internal run IDs, and quarantine detail.
- Select and order dependent entities deterministically so vendors precede repacks, parent categories precede child categories, and referenced repacks/collectibles precede chases.
- Partition release entities into bounded deterministic batches with stable batch numbers and hashes.
- Derive publication identity, content hash, record counts, approved-configuration identity, source watermark, data-as-of time, and source-head freshness from canonical inputs.
- Distinguish immutable content identity from observation freshness so unchanged canonical content does not require new entity rows.
- A complete rebuild and incremental trigger at the same settled state must produce the same content hash and public entity set.

## User-Facing Behavior

No public query shape changes. A complete release contains truthful estimated, unavailable, active, and sold-out records; delayed vendors keep their last settled values and contribute to the release-level delayed count.

## Interface Contract

`CatalogReleasePlanV2` supplies task `004` with:

- the validated existing V2 manifest;
- the settled source watermark and observation/freshness metadata;
- immutable content identity and publication-operation identity;
- exact expected counts and per-entity hash summaries;
- ordered, bounded batches whose items conform to existing Convex publication validators;
- a result classification of `publish`, `refresh_unchanged`, or `blocked` with a stable internal reason.

The plan contains no database handles, secrets, provider payloads, or caller-selected tenant data.

## Acceptance Criteria

- [x] Repeated assembly at the same settled watermark produces byte-stable canonical manifest content, hashes, counts, and batch ordering.
- [x] Full rebuild and change-triggered assembly at the same canonical state reconcile to the same release content hash.
- [x] Unsettled/regressed watermarks, incomplete first backfills, and unapproved public configuration fail closed before publication.
- [x] Later delayed-provider input retains only the provider's last settled public projection and increments `delayedVendorCount`.
- [x] Disabled records are absent, sold-out records are present and non-actionable, and unavailable metrics use bounded reasons rather than zero.
- [x] Referential order and approved origin/action checks pass the existing strict release contract.
- [x] Protected canonical and operational fields cannot enter any release plan or batch.

## Verification

`npm run test:contracts && npm run test:database && npm run test:services`
