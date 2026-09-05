# Task: Retain and Prune Pack and Profile Snapshots

**ID:** pack-version-publication/009
**Depends on:** pack-version-publication/006
**Blocks:** pack-version-publication/010
**Delivery phase:** P09
**Estimated scope:** medium
**Estimated effort:** 1 day for one builder after dependencies are complete, including protection-root, dry-run, authorization, and interrupted-prune verification
**Status:** todo

## Handoff — 2026-09-04

Not started; requires P06's final receipt/recovery behavior. Include unresolved and partially executed operations in retention-root reasoning; P02's repaired recovery primitives preserve immutable operation/receipt evidence even when no ambiguity marker exists. An expired replay is not proof of non-activation. Keep active/previous/held/in-flight/replay-protected roots and the minimum 30-day policy. Implement and verify dry-run classification before any apply path; no production deletion is authorized.

Shared resume instructions: [_handoff.md](_handoff.md). This is a status/context update, not authorization to begin a later phase.

## Start Here

Create pack, provider-profile, and collectible-profile fixtures covering active, previous, recently superseded, held recovery target, staged, failed, replay-protected, old unreachable, and ambiguous snapshots, then classify each at the 30-day boundary.

## Objective

Preserve every immutable snapshot and receipt required for stable reads, recovery, and operation replay while deleting only old unreachable public-store data through bounded, explicitly authorized pruning.

## Context

Active heads must always resolve to complete immutable snapshots. Recovery also needs recently superseded snapshots, held targets, in-flight work, and operation receipts. Without an explicit root policy, pruning can make a readable head incomplete or destroy the evidence required to reconcile an ambiguous request.

Pack, provider-profile, and collectible-profile snapshots follow the same minimum completed-snapshot retention rule. Authoritative provider and central history remains outside public-store pruning.

## Delivery Context

P09 starts after P06 and is independent of P07 and P08. Its review promise is a complete retention classifier, digest-bound dry run, and disabled bounded pruner. After merge, no production snapshot or receipt can be deleted. P10 is the only phase that may issue policy-scoped, expiring production authorization with exact group and byte caps; every apply still requires a fresh current-state plan.

## Requirements

### Protection roots and retention

- Protect every active pack, provider-profile, and collectible-profile snapshot for as long as any head selects it.
- Retain every completed snapshot for at least 30 days, measured from deactivation time for a formerly active snapshot and from durable terminal completion time for a never-active snapshot; each head's immediately previous snapshot remains protected regardless of age.
- Protect staged, finalizing, publishing, retry-scheduled, and otherwise non-terminal snapshots until durable terminal evidence exists; a blocked request becomes terminal only after its reason and any referenced complete recovery snapshot are durable.
- Protect explicit hold and rollback targets, unresolved recovery operations, active leases, and every receipt or idempotency record still inside the 30-day replay window.
- Treat missing, contradictory, unreadable, or concurrently changing root evidence as protected and classify it as ambiguous.

### Safe classification and pruning

- Classify each snapshot group as `protected`, `eligible_after`, or `ambiguous` with exact roots, timestamps, policy version, and stable reason codes.
- Mark a group eligible only when it is complete, terminal, unreachable from every head and recovery root, older than 30 days, and outside the operation replay window.
- Revalidate every root and candidate digest immediately before deletion and refuse a changed or newly reachable group.
- Delete in canonical complete-group order through a signed plan-bound cursor; commit one group's deletion and receipt atomically so interruption resumes after the last receipted group without leaving a reachable or partially removed snapshot.
- Bound evaluated groups, deleted groups, cumulative bytes, receipts, reason text, run duration, and retained execution evidence across the full authorized run rather than resetting caps per page.

### Dry run, authorization, and evidence

- Define an immutable retention-policy digest containing environment, minimum age, protected-root rules, replay window, group and byte caps, and authorization rules; produce a fresh dry-run plan from current heads and roots for every apply attempt.
- Include policy digest, evaluation time, roots checked, candidate identities, ages, counts, bytes, exclusions, expiry, and canonical plan digest in every dry run.
- Require production apply to present the exact unexpired plan digest, an active admin holding `pack_catalog:prune`, explicit P10 launch authorization, trusted execution identity, environment, maximum group count, and maximum byte count.
- Keep manual apply and automatic schedules disabled until P10 authorization; an absent, expired, mismatched, or broader authorization fails closed.
- Record deleted, newly protected, conflicted, missing, skipped, and failed groups without logging snapshot bodies, credentials, protected source evidence, or stack traces.

Provider and central authoritative history, active V1 dependencies, saves, auth, user data, Heat data, and unrelated operations remain outside the pruning target set.

## User-Facing Behavior

Users see no direct retention behavior. Active catalog reads remain complete, per-pack recovery can select a retained prior snapshot, and pruning failure leaves extra unreachable data rather than risking a missing pack or profile.

## Interface Contract

`PackProfileSnapshotRetentionPolicyV1` names the environment, minimum 30-day threshold, protected-root rules, replay window, group and byte caps, authorization rules, and canonical policy digest. `PackProfileSnapshotRetentionPlanV1` names that policy digest, current evaluation time, protected roots, the canonically ordered immutable eligible-group manifest, ambiguous groups, counts, estimated bytes, expiry, and canonical plan digest.

The bounded prune operation accepts a freshly evaluated plan digest, P10 `pruningAuthorizationId`, authorizing launch-ledger digest, authorized policy digest, authorization expiry, optional `PackProfilePruneCursorV1`, maximum group count, and maximum bytes. It returns deleted, already-deleted, skipped-protected, conflicted, missing, failed, cumulative counts/bytes, and next-cursor results.

`PackProfilePruneCursorV1` is opaque and signed and binds environment, policy digest, plan digest, authorization identity, ordered candidate-manifest digest, last receipted group key, cumulative groups/bytes, issue time, and expiry. Resume scans only the next manifest entry and revalidates its current roots. A group absent from storage is `already_deleted` only when an exact same-plan deletion receipt exists; otherwise it is `missing` and the run fails closed. Same-plan receipted deletions are expected progress and do not invalidate later pages, while a changed head, root, remaining candidate, scope, policy, authorization, cursor, or cumulative cap prevents the affected deletion.

Terminal operation receipts and idempotency evidence remain available throughout the 30-day replay window. Provider and central histories remain authoritative after eligible public-store snapshots and expired receipts are pruned.

## Acceptance Criteria

### Protection and eligibility

- [ ] Active, previous, held, in-flight, recoverable, leased, and replay-protected pack/profile snapshot groups are never eligible.
- [ ] A formerly active snapshot remains for at least 30 days from deactivation, and a never-active completed snapshot remains for at least 30 days from durable terminal completion, including exact threshold fixtures for both clocks.
- [ ] Only complete, terminal, unreachable groups older than 30 days and outside every recovery or replay root become eligible.
- [ ] Missing, contradictory, changing, or unreadable evidence produces `ambiguous` and prevents deletion.
- [ ] Provider/central history and every named protected system remain outside the candidate inventory.

### Bounded authorized execution

- [ ] Every apply uses a fresh dry run that records exact current roots, candidates, counts, bytes, policy digest, environment, expiry, and plan digest without mutation.
- [ ] Production pruning is impossible before exact P10 authorization by an active admin holding `pack_catalog:prune` and fails closed for untrusted execution, expiry, mismatch, or broader scope.
- [ ] Head or root changes between planning and apply invalidate the affected candidate before deletion.
- [ ] Signed plan-bound cursor resume and exact replay preserve cumulative caps, recognize only same-plan deletion receipts as already deleted, and converge without partial snapshot groups or loss of reachable data.
- [ ] Results and logs remain bounded and contain no snapshot body, credential, protected evidence, or stack trace.

## Verification

Named scenario: **Thirty-day snapshot retention and bounded prune** — classify every fixture at the threshold, inject concurrent head and root changes, interrupt and resume bounded execution, reject invalid authorization, and prove every readable or recoverable snapshot remains complete.
