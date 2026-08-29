# Task: Publish Shared Catalog Versions Safely

**ID:** distributed-canonical-warehouse/012
**Depends on:** distributed-canonical-warehouse/006
**Blocks:** distributed-canonical-warehouse/015, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including deterministic versioning, receipt reconciliation, and protected-data checks
**Status:** in progress

## Start Here

Define one catalog-version fixture containing a category tree, canonical collectibles, one provisional collectible, and one alias, then record its expected deterministic IDs, counts, hashes, and publication checkpoint.

## Objective

Turn the mutable shared catalog into immutable, verified versions that provider releases can reference and the Convex manifest can gate without exposing correlation evidence or provider-local protected data.

## Context

The central global catalog changes independently from provider databases. A mutable global row plus a change sequence cannot reconstruct an older snapshot after later updates, so publication must produce an immutable catalog version. Each provider manifest entry pins the exact catalog version required by its active provider release.

Catalog publication is server-only, bounded, idempotent, and receipt-confirmed. Completing a catalog version makes it eligible for a manifest entry; it does not make any provider publicly active by itself.

## Requirements

### Immutable catalog version

- Claim one stable central catalog promotion boundary and materialize the category tree, global collectibles, lifecycle, public attributes, and permanent aliases visible through that boundary.
- Assign an immutable catalog version ID and record schema version, through-change sequence, deterministic ordering, entity counts, content hashes, and creation time.
- Include provisional global collectibles as ordinary stable public identities and exclude unresolved suggestions from public identity changes.
- Validate category hierarchy, collectible types, active identities, alias targets, alias cycles, uniqueness, and bounded public fields before completion.
- Keep correlation confidence, provider evidence, admin identity, credentials, exact instances, provider accounts, raw payloads, and quarantine details out of the catalog artifact.

### Publication operations

- Publish through authenticated server-only start, bounded batch, finalize, status, block, and reuse operations.
- Bind every operation to catalog version ID, schema version, exact request digest, idempotency key, batch index, body hash, and expected counts.
- Store exact bounded request and receipt evidence needed to reconcile a lost response without repeating a different operation.
- Mark a catalog version complete only after count, hash, hierarchy, alias, and reference verification succeeds.
- Keep incomplete, blocked, failed, or conflicting versions ineligible for manifest selection.

### Checkpoint and recovery

- Advance the central catalog publisher checkpoint only after the exact Convex receipt is durably reconciled.
- Leave later catalog changes pending for the next version when they occur after the claimed boundary.
- Reuse a prior complete version when the selected public content hash is unchanged.
- Recover after timeout, lost acknowledgement, worker restart, and duplicate delivery without producing two logical versions or skipping a change sequence.
- Retain active, previous, in-flight, and authorized rollback catalog versions and every receipt they require.

## User-Facing Behavior

There is no direct admin screen in this task. Public catalog identity changes become visible only after a provider manifest entry selects a compatible complete catalog version. Provisional collectibles can publish, aliases preserve old IDs, and ambiguous suggestions remain invisible as suggestions.

## Interface Contract

A complete catalog descriptor contains `catalogVersionId`, schema version, through-change sequence, category count, collectible count, alias count, content hash, lifecycle `complete`, and completion receipt. Its public batches contain only allowlisted category, collectible, and alias fields.

A provider release may reference only one complete catalog descriptor whose schema version and content identities satisfy that release's declared requirements.

## Acceptance Criteria

### Version acceptance

- [ ] The same stable catalog boundary produces identical ordering, IDs, counts, hashes, and version reuse behavior.
- [ ] A complete version contains valid category paths, provisional identities, and acyclic aliases while excluding ambiguous suggestions and protected evidence.
- [ ] Missing alias targets, alias cycles, invalid hierarchy, duplicate IDs, invalid types, and count or hash mismatches block completion.
- [ ] Later mutable catalog changes do not alter an already complete version.
- [ ] An unchanged public content hash reuses the complete version without duplicate public artifacts.

### Publication acceptance

- [ ] Start, batch, finalize, status, block, and reuse operations are server-only, bounded, authenticated, and idempotent.
- [ ] Timeout, duplicate delivery, lost acknowledgement, and restart reconcile the exact receipt before checkpoint advancement.
- [ ] Failed or incomplete versions are never selectable by a provider manifest entry.
- [ ] Public batches contain no provider evidence, credentials, exact instances, accounts, raw payloads, quarantine, or admin identity.
- [ ] Catalog publisher and correlator checkpoints remain independent and retention protects both consumers.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Catalog snapshots use the commit-ordered catalog boundary and exact canonical bytes and receipts before checkpoint advancement.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
