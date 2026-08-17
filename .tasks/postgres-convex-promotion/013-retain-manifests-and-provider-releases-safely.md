# Task: Retain Manifests and Provider Releases Safely

**ID:** postgres-convex-promotion/013
**Depends on:** postgres-convex-promotion/009, postgres-convex-promotion/010
**Blocks:** postgres-convex-promotion/014
**Estimated scope:** medium
**Estimated effort:** 1–3 days for one builder, including reference-graph and bounded-deletion verification
**Status:** in progress

## Start Here

Create retained manifests that share provider releases, add unreferenced completed and abandoned releases for two platforms, run cleanup repeatedly, and prove every protected reference survives while each platform and the manifest pool converge to their bounds.

## Objective

Bound immutable catalog storage independently for each provider and for global manifests without deleting an active, rollback, completed-head, retained-manifest, or in-flight dependency.

## Context

Provider releases are reused across manifests, so age alone cannot determine whether a release is deletable. One provider may publish far more often than another, which also makes a single global release quota unfair and unbounded by owner. Retention must traverse the manifest reference graph, protect recovery targets, and delete in Convex-safe batches.

## Requirements

### Protection graph

- Protect the active and previous manifests unconditionally, plus every provider release referenced by any manifest retained under policy.
- Protect each platform's latest completed head, each active provider head, every release or manifest named by an in-flight PostgreSQL attempt, and every authorized rollback/block recovery target.
- Recompute protection from authoritative manifests and exact PostgreSQL attempt/head proofs; do not trust orphan rows or caller-supplied identifiers.
- Never delete a provider release while any retained manifest references it, even when the release is old or shared by many manifests.
- Keep authentication nonce, operation-receipt, and Heat retention independent while preserving their existing safety guarantees.

### Bounded policy

- Retain active and previous manifests, then at most three additional complete manifests for seven days; retain staging or failed manifests for at most 24 hours.
- For each `platformKey` independently, retain protected releases, then at most three additional complete provider releases for seven days; retain staging or failed provider releases for at most 24 hours.
- Apply the complete-count and age bounds together: an unprotected artifact is eligible when it exceeds its owner count or age allowance.
- Delete at most 100 owned documents per mutation and continue in fresh bounded transactions until the selected artifact is fully removed.
- Remove eligible manifests before recalculating provider-release eligibility, and fail closed when reference or receipt proof is incomplete.

## User-Facing Behavior

Retention never changes the active public catalog or Heat. A safe retained manifest can still be rolled back; an expired unprotected target is no longer offered as a recovery target.

## Interface Contract

`CatalogRetentionProtectionSet` contains protected manifest IDs, protected provider release IDs grouped by `platformKey`, proof reasons, and the authoritative evaluation time.

Manifest retention returns a bounded progress receipt before provider retention runs against the updated reference graph. Provider retention returns per-platform progress and never accepts a public caller, tenant selector, unresolved manifest reference, or unproven rollback target.

## Acceptance Criteria

### Reference safety

- [ ] Active, previous, retained-manifest, completed-head, active-head, in-flight, and authorized recovery dependencies are never selected or partially deleted.
- [ ] One provider release referenced by several retained manifests is deleted only after the last protecting manifest leaves retention.
- [ ] Missing or inconsistent manifest, head, attempt, or receipt proof stops cleanup without dangling references.
- [ ] Rollback to every retained eligible manifest still resolves all provider content after cleanup.

### Bounds and progress

- [ ] Complete manifests converge to active, previous, and at most three additional seven-day candidates.
- [ ] Each platform independently converges to its protected releases and at most three additional seven-day complete candidates.
- [ ] Staging and failed provider releases/manifests become eligible after 24 hours without affecting another owner.
- [ ] Every mutation deletes at most 100 owned documents and repeated cleanup makes deterministic forward progress.

## Verification

`npm run test:convex && npm run typecheck:convex && npm run test:services`
