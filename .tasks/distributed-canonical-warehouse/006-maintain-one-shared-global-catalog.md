# Task: Maintain One Shared Global Catalog

**ID:** distributed-canonical-warehouse/006
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/004
**Blocks:** distributed-canonical-warehouse/012, distributed-canonical-warehouse/013, distributed-canonical-warehouse/018, distributed-canonical-warehouse/019
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including deterministic correlation, alias safety, and replay verification
**Status:** not started

## Start Here

Write five canonical examples—deterministic match, unmatched collectible, ambiguous match, replay, and merge alias—and record the exact global identity and correlation outcome expected for each.

## Objective

Maintain one central category and collectible identity space that correlates provider-local catalogs without blocking provider work or forcing premature product normalization.

## Context

The shared catalog lives in `packscout` and is available to every organization. Provider-local catalogs remain authoritative for provider facts, exact instances, and pack contents. Central correlations use soft provider and local-entity references because there is no transaction or foreign key across database authorities.

Every valid provider collectible must be publishable even when no trusted match exists. The catalog therefore creates a stable provisional global collectible immediately. Deterministic evidence may correlate identities automatically. Fuzzy or ambiguous evidence records a suggestion without merging identities. Current admin catalog-governance screens are outside this feature.

## Requirements

### Global identities

- Store `GLOBAL_CATEGORIES` as a valid central tree with stable public IDs, lifecycle, display identity, bounded attributes, timestamps, and row versions.
- Store `GLOBAL_COLLECTIBLES` with the UUID used as `publicCollectibleId`, primary category, collectible type, identity state, bounded public identity attributes, timestamps, and row versions.
- Keep provider packs, exact collectible instances, provider accounts, certifications, raw evidence, and source-record mappings out of the global catalog.
- Give an unmatched valid provider collectible a new stable provisional global ID in the same idempotent correlation operation.
- Keep the global catalog shared across organizations while every provider correlation retains its organization-owned provider identity.

### Correlations and suggestions

- Store temporal provider-category and provider-collectible correlations using provider ID, local entity ID and version, global ID, rule version, method, bounded confidence, and validity interval.
- Apply an automatic correlation only when versioned deterministic evidence yields exactly one global identity.
- Store bounded `CORRELATION_SUGGESTIONS` for ambiguous candidates without changing the current correlation or retiring the provisional identity.
- Make correlation replay and processing order produce the same global ID and active correlation.
- Reject stale local versions, missing provisionals, invalid global types, cross-provider evidence, and conflicting deterministic outcomes with sanitized durable evidence.

### Aliases and catalog history

- Store permanent `COLLECTIBLE_ALIASES` from a retired global ID to one surviving global ID; aliases are immutable and acyclic.
- Resolve an alias chain to one surviving ID while preserving every retired public ID as a valid saved-reference lookup.
- Record provisional creation, deterministic link, suggestion, correlation replacement, retirement, and alias creation as append-only catalog events.
- A public-reference change appends a central catalog promotion change and increments the affected global row version in one central transaction.
- Keep manual merge and attribute-governance screens out of the current admin application; the data model and server-only maintenance boundary preserve alias behavior for later use.

### Asynchronous reconciliation

- Consume provider promotion changes asynchronously and idempotently with an independent confirmed correlation checkpoint for each provider.
- Let provider commits continue while `packscout` is unavailable; correlation resumes from the last confirmed provider sequence.
- Give correlation and Convex catalog publication separate consumer checkpoints so one consumer cannot erase another consumer's pending work.
- Retain provider change rows until every required consumer has confirmed a sequence beyond them.
- Expose correlation lag, last confirmed sequence, safe failure code, and observation time without exposing protected provider evidence.

## User-Facing Behavior

A newly discovered collectible can appear publicly under a stable provisional ID without waiting for review. A later merge does not break saved collectible references: both the retired ID and surviving ID resolve to the surviving collectible. Ambiguous candidates remain separate and do not silently combine user-visible identities.

## Interface Contract

A correlation request contains `providerId`, local entity ID and version, collectible type, bounded deterministic identity evidence, rule version, and provider change sequence. It returns `linked`, `provisional_created`, `suggested`, `unchanged`, or `rejected`, plus the current global ID and confirmed provider sequence when successful.

Global catalog consumers receive versioned category, collectible, correlation, alias, retirement, and change records. They never receive provider database handles, exact instances, provider accounts, raw payloads, or unresolved external identifiers.

## Acceptance Criteria

### Identity acceptance

- [ ] An unmatched collectible receives the same provisional global ID across retries and processing order changes.
- [ ] A deterministic unique match links automatically, while an ambiguous match creates a suggestion and leaves identities separate.
- [ ] Cross-provider, stale-version, conflicting, and type-incompatible evidence fails without corrupting an active correlation.
- [ ] A merge creates an immutable alias, rejects cycles, and preserves both old and surviving public-ID lookups.
- [ ] Exact instances and provider-protected data never appear in central global identity records.

### Reconciliation acceptance

- [ ] Provider commits succeed during central outage and correlate after recovery from the last confirmed sequence.
- [ ] Correlation replay has exactly-once effect and never advances its checkpoint past a failed record.
- [ ] Catalog changes and their promotion-change records commit atomically.
- [ ] Correlation and catalog-publisher checkpoints advance independently, and retention protects work pending for both consumers.
- [ ] Property tests cover provisional stability, deterministic linking, ambiguous non-linking, alias resolution, and cycle rejection.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Global identities, temporal correlations, commit-ordered ledgers, aliases, and provider invalidations follow the contracted tables and sequence rules.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
