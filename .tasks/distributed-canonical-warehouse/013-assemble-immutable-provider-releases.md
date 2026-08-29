# Task: Assemble Immutable Provider Releases

**ID:** distributed-canonical-warehouse/013
**Depends on:** distributed-canonical-warehouse/006, distributed-canonical-warehouse/007, distributed-canonical-warehouse/012
**Blocks:** distributed-canonical-warehouse/014
**Estimated scope:** large
**Estimated effort:** 5–7 days for one builder, including stable snapshots, deterministic projections, and compatibility validation
**Status:** not started

## Start Here

Build one expected release descriptor from a stable provider fixture and one complete global catalog version, listing every public entity, excluded entity, reference, count, and hash before implementing release assembly.

## Objective

Assemble a complete, deterministic, immutable provider release from one stable provider checkpoint and one pinned shared-catalog version without exposing a partially promoted catalog.

## Context

Provider rows are mutable, so the promotion-change ledger is a wake-up and checkpoint mechanism rather than a historical row store. The assembler claims a provider boundary, reads one transactionally consistent provider snapshot, resolves every public collectible reference against one immutable catalog version, and produces a release that never changes afterward.

The release is provider-scoped. It contains frontend-safe provider presentation, repacks, economics, classifications, content summaries, and global collectible references. Exact instances, accounts, raw pulls, market-event histories, credentials, runtime, runs, quarantine, and audit data remain private.

## Requirements

### Snapshot boundary

- Claim one provider promotion sequence and read a transactionally consistent snapshot through that sequence without opening a central distributed transaction.
- Pin one complete global catalog version and require every published category and collectible reference to exist and remain valid in that version.
- Treat provider and catalog changes after the claimed boundaries as work for a later release.
- Reject stale worker fences, schema mismatch, provider identity mismatch, missing soft references, incomplete correlations, and invalid retirement state before producing a complete artifact.
- Allow provisional global collectible IDs because they are complete catalog identities, not unresolved suggestions.

### Public projection

- Produce one frontend-safe provider identity and stable public repack IDs scoped to the provider.
- Project available and retired packs, category assignments, content summaries, collectible chase relationships, approved media and actions, exact price and currency, buyback, odds, and current public EV fields.
- Use the global collectible UUID as `publicCollectibleId` and resolve retired IDs through catalog aliases.
- Preserve explicit unavailable values and freshness rather than converting missing metrics to zero or stale values to current.
- Exclude exact instances, provider accounts, actors, pulls, market-event histories, credentials, connection data, raw evidence, runtime, run, quarantine, and audit state.

### Determinism and completeness

- Record provider release ID, provider ID, provider key, provider checkpoint, catalog version ID, schema versions, deterministic entity ordering, counts, hashes, and freshness metadata.
- Validate stable ID uniqueness, reference completeness, category paths, pack-content consistency, public-field bounds, money and currency pairs, and retirement behavior.
- Split artifacts into bounded deterministic batches while keeping one release-level hash and count reconciliation.
- Reuse a prior complete provider release when provider public content and pinned catalog requirements are unchanged.
- Make a complete release immutable and independent from later provider mutations, correlations, or runs.

### Failure isolation

- A failed provider assembly leaves its prior complete release and every other provider's release eligible for use.
- Failure does not advance the provider publisher checkpoint or discard unconsumed promotion changes.
- Bounded safe diagnostics identify provider, claimed sequence, catalog version, stage, failure code, and retryability without protected data.
- Assembly can restart from durable operation state without reusing a mismatched snapshot or digest.
- Representative fixtures cover cards, watches, art, multi-item packs, unavailable economics, retirements, provisional identities, and aliases.

## User-Facing Behavior

No partial release is visible. A provider's complete release contains coherent pack, category, collectible, odds, buyback, and EV data from one provider checkpoint. Missing protected or internal data cannot leak into frontend responses. A provider assembly failure leaves the previously active public data unchanged.

## Interface Contract

A provider release descriptor contains `providerReleaseId`, provider identity, provider checkpoint, catalog version ID, public schema version, lifecycle, entity and batch counts, content and index hashes, freshness metadata, and predecessor complete release ID when present.

The assembler consumes provider-local typed rows and promotion state plus a complete catalog descriptor. It emits immutable bounded public batches and a descriptor; it does not activate the release or advance a Convex manifest.

## Acceptance Criteria

### Snapshot acceptance

- [ ] One stable provider checkpoint and one complete catalog version produce a deterministic immutable release descriptor and batches.
- [ ] Concurrent later provider or catalog updates do not change the claimed release and remain pending for a later release.
- [ ] Missing, stale, cross-provider, incomplete, or incompatible soft references block completion without advancing checkpoints.
- [ ] Provisional identities publish, while unresolved suggestions and unresolved local subjects do not.
- [ ] An unchanged public projection reuses the prior complete release.

### Public-boundary acceptance

- [ ] Provider, repack, category, collectible, chase, economics, freshness, and retirement projections preserve current public field semantics.
- [ ] Exact instances, accounts, pulls, events, credentials, raw evidence, runtime, quarantine, and audit data are absent from every artifact.
- [ ] Counts, hashes, ordering, category paths, references, money pairs, and public bounds reconcile before lifecycle becomes complete.
- [ ] One provider assembly failure leaves another provider and the prior complete release unaffected.
- [ ] Representative mixed-collectible fixtures and unavailable-value fixtures pass release validation.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Assembly requires a complete immutable catalog version and pins its correlation and public-profile hashes before opening the provider snapshot.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
