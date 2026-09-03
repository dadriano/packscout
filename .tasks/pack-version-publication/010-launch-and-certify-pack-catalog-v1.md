# Task: Launch and Certify Pack Catalog V1

**ID:** pack-version-publication/010
**Depends on:** pack-version-publication/008, pack-version-publication/009
**Blocks:** none
**Delivery phase:** P10
**Estimated scope:** medium
**Estimated effort:** 4–8 hours for the authorized release team after dependencies are complete, including pause, readiness checks, launch, smoke testing, and evidence capture
**Status:** todo

## Start Here

Pin the exact merged commit, production configuration, desired-state cutoff, current disabled `PackCatalogWorkerGateV1` generation, active admin holding `pack_catalog:launch`, and trusted deployment identity, then verify the exact `PackCatalogLaunchPlanV1` is `approved_to_seed` and the `PackProfileSnapshotRetentionPolicyV1` digest is current.

## Objective

Expose `pack_catalog_v1` as Packscout's only public pack catalog without a maintenance window, mixed pack state, broken stable identity, or unavailable read interval, then enable normal per-pack publication.

## Context

P01–P09 produce one complete V1 system. Pack and profile snapshots are immutable, each pack has its own atomic head, the API and frontend consume the same contract directly, recovery works within V1, and production pruning remains disabled.

Launch changes deployment routing and enables already-certified V1 operations. It does not change the data model, translate another contract, or add an application-level source switch. Ingestion may pause while final desired states drain. The release platform keeps the pre-launch application artifact as a short-lived blue/green rollback target until certification; V1 code cannot call it, and no V1 publication writes reach it.

## Delivery Context

P10 is an authorized production operation against the exact commit certified by P08 and protected by P09. It creates no implementation PR. Before public exposure, any failed check aborts the operation and leaves routing unchanged. A failed smoke check may restore the pre-launch application artifact only while V1 writers remain disabled. Green smoke makes V1 authoritative, removes that route rollback, and only then permits recurring V1 writes; later recovery stays within V1.

## Requirements

### Prepare and freeze

- Record the exact commit, configuration digest, desired-state cutoff, disabled `PackCatalogWorkerGateV1` generation, `PackCatalogLaunchPlanV1` digest and status, `PackProfileSnapshotRetentionPolicyV1` digest, active admin with `pack_catalog:launch`, trusted deployment identity, timestamps, and rollback authority before changing production.
- Verify provider database reachability and schema state independently without allowing one unavailable provider to invalidate another provider's certified packs.
- Freeze the P08 inventory digest, include every ready entity at the cutoff, record waiting, blocked, or unreachable entities as excluded and absent, and require at least one included pack; an excluded entity never blocks another pack's launch.
- Invoke P06 `seed-pack-catalog` for the plan's immutable included/excluded inventory through the normal planner, assembler, and publisher while recurring claiming remains disabled; require complete matching heads for every included entity, no reachable head for any excluded or undeclared entity, and no unresolved operation.
- Keep recurring work disabled through the P06 gate, drain the separately authorized V1 seed work to the recorded cutoff, and require a post-seed `PackCatalogLaunchReadinessV1.ready` result bound to the exact launch-plan digest while the pre-launch application remains publicly routed.

### Launch and verify

- Expose only the exact certified V1 application release through the deployment platform's atomic routing operation.
- Exercise shell status, dashboard, pack list, pack detail, collectible search, and desired-collectible lookup before enabling recurring writers; verify saves and direct links across those journeys.
- Verify stable URLs, saves, query state, lifecycle visibility, action gating, full contents, odds, chase, valuations, and EV from the active snapshot of each sampled pack.
- Abort before exposure when a readiness check fails; if smoke testing fails after exposure, keep writers disabled and use the authorized blue/green route rollback without changing pack heads.
- After all launch smoke checks pass, make V1 authoritative and remove the pre-launch artifact from the launch rollback slot before using P06 `PackCatalogWorkerControl.setGate` against the recorded generation to enable per-pack publication, Admin-only alerts, authorized read-only monitoring, and resumed ingestion; keep pruning disabled.

### Certify operation

- Observe two post-resume pack changes and prove that each advances only its own head while unrelated pack and provider state remains unchanged.
- Prove reads remain available while one provider is unreachable and while one pack is held for recovery.
- Seal an immutable launch ledger containing inputs, checks, routing result, authority boundary, enablement result, smoke evidence, first independent activations, and final status; a successful ledger issues bounded pruning authorization and only then may pruning enable.
- Accept only `succeeded` or `aborted` as terminal outcomes; partial or unknown outcomes keep writers and pruning disabled until reconciled.

## User-Facing Behavior

Deployment mechanics introduce no maintenance page, transient catalog error, broken URL, lost save, identity change, or mixed pack view. Users receive the native V1 experience, including stable pack state, full contents, explicit lifecycle visibility, and no Heat surface.

## Interface Contract

`PackCatalogV1LaunchLedger` binds the exact application commit and configuration, desired-state cutoff, `PackCatalogLaunchPlanV1` digest and `approved_to_seed` status, `PackCatalogLaunchReadinessV1` digest and `ready` status, inventory digest, `PackProfileSnapshotRetentionPolicyV1` digest, active-head coverage digest, actor authorization, routing operation, smoke results, prior and resulting worker-gate generations plus receipts, first post-resume publications, and terminal outcome. A successful ledger alone issues a bounded `pruningAuthorizationId`, policy digest, expiry, group cap, and byte cap; an aborted ledger issues none.

P08 supplies `PackCatalogLaunchPlanV1` before seeding and evaluates `PackCatalogLaunchReadinessV1` afterward. P09 supplies `PackProfileSnapshotRetentionPolicyV1`, fresh per-apply plans, and the production-pruning gate. P10 rejects any digest, status, inventory, cutoff, scope, policy, or expiry mismatch and consumes these artifacts without creating another publication or read contract.

After certification, ordinary recovery is limited to V1 behavior: hold or retry one pack, atomically select its retained prior snapshot, pause writers, or deploy the last certified V1 application artifact through the release platform.

## Acceptance Criteria

### Readiness and availability

- [ ] The exact commit, configuration, cutoff, disabled worker-gate generation, launch-plan digest/status, inventory digest, retention-policy digest, active launch admin, trusted deployment identity, and recovery boundary are recorded before production changes.
- [ ] The fixed inventory includes every ready entity, records every excluded entity and reason, contains at least one pack, and lets an unavailable provider or non-ready pack remain absent without blocking included packs.
- [ ] Every included profile and pack has one complete, hash-valid active head, every excluded or undeclared identity has no reachable head, and no publication ambiguity remains.
- [ ] A failed pre-exposure check aborts with routing, the worker gate, alerts, and pruning unchanged.
- [ ] The bounded seed invocation uses the normal V1 flow while recurring claiming remains disabled.

### Public exposure

- [ ] The deployment platform exposes exactly the certified V1 application release.
- [ ] Public exposure occurs only after post-seed readiness is `ready` and bound to the exact approved launch plan, included inventory, heads, hashes, and query smoke evidence.
- [ ] All six catalog journeys pass with stable identities, saves, URLs, query state, and coherent complete pack snapshots.
- [ ] A failed post-exposure smoke check keeps writers disabled and exercises the authorized blue/green route rollback without mutating pack heads.

### V1 authority and certification

- [ ] Green smoke removes the pre-launch route rollback before the fenced worker-gate command enables recurring V1 writes; the exact gate receipt, Admin-alert persistence, and monitoring then enter the ledger, while pruning waits for bounded authorization from its successful terminal outcome.
- [ ] Two independent post-resume pack changes, provider-isolation behavior, and the immutable terminal ledger are verified.

## Verification

Named scenario: **First Pack Catalog V1 launch** — execute the production runbook against the exact certified commit, approved launch plan, post-seed readiness, and retention-policy digest; expose only the prepared V1 release, exercise the canonical six journeys plus saves and direct links, and accept only a fully succeeded or fully aborted ledger.
