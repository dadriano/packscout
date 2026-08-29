# Task: Advance Provider Manifest Gates Independently

**ID:** distributed-canonical-warehouse/015
**Depends on:** distributed-canonical-warehouse/012, distributed-canonical-warehouse/014
**Blocks:** distributed-canonical-warehouse/016, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018, distributed-canonical-warehouse/019
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including atomic activation, compatibility checks, rollback, and receipt reconciliation
**Status:** not started

## Start Here

Write one active-manifest example with two provider entries, then record the exact before and after manifest when only one provider advances and the other provider entry must remain byte-for-byte unchanged.

## Objective

Make one Convex manifest the atomic public gate while allowing each provider's complete release and compatible catalog version to advance independently.

## Context

Public queries resolve one active manifest before reading catalog data. The manifest contains one gated selection per provider rather than one all-provider release barrier. Each selection pairs a complete immutable provider release with the complete shared-catalog version used to validate that release.

Changing one provider creates and atomically activates a new manifest revision that preserves every unrelated provider entry. A failed activation leaves the prior manifest active. Provider runtime disablement does not silently unpublish data; inclusion, removal, and rollback are explicit manifest operations.

## Requirements

### Manifest model

- Store one active immutable manifest revision with stable manifest ID, predecessor, schema version, fingerprint, creation time, and one unique entry per active provider.
- Pair each entry's provider ID and public provider key with one complete provider release ID and one compatible complete catalog version ID.
- Keep separate completed and active provider heads so release upload, catalog publication, and public activation remain distinct.
- Reject duplicate providers, missing releases, incomplete artifacts, provider mismatch, catalog mismatch, schema mismatch, invalid aliases, and dangling public references.
- Keep manifests free of database addresses, credentials, internal cursors, protected evidence, and admin session data.

### Independent activation

- Activate through one compare-and-swap operation against the expected active manifest revision and exact new manifest fingerprint.
- Advance, add, remove, or roll back one provider entry while preserving every unrelated entry exactly.
- Require the selected provider release to be complete and bind it to the catalog version it was assembled against.
- Preserve the prior active manifest on conflict, timeout, validation failure, blocked release, or lost acknowledgement.
- Avoid an all-provider activation barrier; one delayed or failed provider does not prevent another provider gate from advancing.

### Receipts and recovery

- Bind activation to provider ID, expected prior manifest, new manifest fingerprint, selected release, selected catalog version, idempotency key, and exact request digest.
- Reconcile duplicate delivery, timeout, lost acknowledgement, and worker restart from the exact manifest receipt before recording success.
- Return the current active manifest on a stale compare-and-swap conflict without overwriting it.
- Retain active, previous, in-flight, blocked, and authorized rollback manifests plus every provider release and catalog version they reference.
- Record provider-gate activation, conflict, rollback, removal, retry, receipt, and lag metrics without protected data.

## User-Facing Behavior

Users see a provider update all at once. They never see half of a new provider release or a collectible reference from the wrong catalog version. If one provider activation fails, its previous public version and every healthy provider remain available. Rollback changes only the selected provider entry.

## Interface Contract

An active manifest contains `manifestId`, predecessor manifest ID, schema version, fingerprint, activation time, and provider entries shaped as `{ providerId, providerKey, providerReleaseId, catalogVersionId }`.

An activation command contains one target provider, expected active manifest ID, target completed release and catalog version, operation `advance | add | remove | rollback`, exact digest, and idempotency key. Its receipt identifies the resulting active manifest and unchanged provider-entry count.

## Acceptance Criteria

### Gate acceptance

- [ ] One active manifest selects complete provider release and catalog version pairs with unique provider entries.
- [ ] Advancing one provider changes only that provider entry and the immutable manifest metadata.
- [ ] Missing, incomplete, incompatible, cross-provider, dangling, or blocked artifacts prevent activation.
- [ ] Add, remove, and rollback are explicit provider-entry operations and do not follow runtime disablement implicitly.
- [ ] A failed provider does not create an all-provider activation barrier.

### Atomicity acceptance

- [ ] Compare-and-swap activation is atomic and stale requests preserve and return the current active manifest.
- [ ] Duplicate request, timeout, lost acknowledgement, and restart reconcile the exact activation receipt.
- [ ] Validation or receipt failure leaves the prior active manifest and all provider entries readable.
- [ ] Retention protects every manifest, release, and catalog version required for active, previous, in-flight, or rollback state.
- [ ] Gate diagnostics and metrics contain no credentials, database details, internal cursors, or protected provider data.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- The manifest operation vocabulary is exactly `advance | add | remove | rollback`; no duplicate `clear` synonym exists.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
