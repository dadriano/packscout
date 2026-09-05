# Task: Publish and Recover Pack State

**ID:** pack-version-publication/006
**Depends on:** pack-version-publication/002, pack-version-publication/003, pack-version-publication/004, pack-version-publication/005, pack-version-publication/011
**Blocks:** pack-version-publication/008, pack-version-publication/009
**Delivery phase:** P06
**Estimated scope:** large
**Estimated effort:** 2–3 days for one builder after dependencies are complete, including crash, network, fencing, retry, rollback, authorization, and isolation verification
**Status:** todo

## Signed-status integration follow-up — 2026-09-05

Read-only implementation map: production capture implements `PackInputCapture.capture(tx, …)` through the existing bounded provider gateway, with immutable shared/profile dependencies prepared before entering that transaction. Compose existing request/assembler/artifact/outbox classes rather than duplicate persistence. P02 journals a domain-hashed publication operation while signed transport hashes the complete wire request: durably bind the exact replay-stable envelope and both meanings before I/O, never substitute one digest for the other. P04 already journals full wire requests. Root owns shared journal/gate/schema ports; capture, pack publication, and profile/shared-delivery service groups may fan out after011 contracts freeze; worker/CLI composition follows. Gate generation must fence progress commits as well as claims. P08 supplies readiness evidence;006 must not invent it or activate production.

P04 independent review found a pre-existing P05 recovery seam: `convex/packCatalogOperationStore.ts:describeOperation` delegates exact live status to `evaluatePublicationReplay`, returning already_applied/null reason even when the stored original operation was refused. P04's queue repair deliberately retains the ambiguity barrier without an original definitive refusal; do not test lost-refusal recovery with a synthetic status result the actual store cannot emit. During006 integration, preserve the stored operation outcome/reason in exact authorized signed status (or prove the existing exact transport recovery obtains the original receipt), and test the real P05→P04 path for lost refusal, successful activation, expiry, mismatched bytes, organization/entity scope and no unsafe supersession. This is the existing status operation, not a new public API, adapter or permissive fallback.

Concrete read-only fix map: keep `describeOperation` scope/entity fences and replay expiry/digest eligibility. When eligibility says already_applied, validate/load the stored immutable receipt and return its original result, reusing/factoring `findPackCatalogReplay`'s stored-receipt checks. Do not change `evaluatePublicationReplay` globally: it describes eligibility, not the original outcome. Existing statusOperation already supports refused/conflict/already_active outcomes and reasons. Preserve already_active because P04 completion uses it to distinguish unchanged generation. Exact resend alone is insufficient after the original service identity expires; authorization precedes replay, while fresh read_receipt authority with the same authorization scope can query a still-live original operation.

Regression seam: route the production signed client's injected fetch through `convex-test`'s actual `t.fetch`, and pair it with real migrated central PostgreSQL/outbox classes. Durably record a profile activation, obtain a genuine refused/blocked/INVALID_DOMAIN_DATA receipt from a blocked staged snapshot, then deliberately drop the response. Reclaim, durably record a fresh exact-status request, persist the actual verified signed response, and prove correction can proceed with no head change or cross-scope effect. Cover applied, already_active, absent/expired/mismatched lookups, stale lease, foreign scope and exact resend. No implementation or test pass is claimed by this preparation note.

## Handoff — 2026-09-04

Not started.002/005 are merged;003/004 are implemented in PR114/119 with repaired-head certification pending.011 full-data parity remains incomplete and waits merged003/005/013 (neutral core PR121). These are actual prerequisites;005 alone does not unblock006. The user authorizes remaining builds with delegation, not production activation. P02's crash/partial-expiry fixes are already merged in PR95 and remain owned by002. This phase owns authenticated remote status reconciliation, transaction-local capture composition, worker registration and the full external-write crash matrix. Reconcile persisted operations even without an ambiguity marker; use `retireReconciled` only with authenticated non-activation evidence, never a missing receipt or expired replay. Workers and credentials stay disabled until separate launch authorization.

Shared resume instructions: [_handoff.md](_handoff.md). This is a status/context update, not authorization to begin a later phase.

## Start Here

### Parallel implementation brief after prerequisites merge

Run independently of007 from the same verified011 parent. Own the pack/profile publisher and recovery services, transactional native PackInputCapture adapter, shared-delivery worker, P02/P04 repository and worker-gate wiring, `apps/worker` composition/runtime configuration, and environment-scoped seed/recovery/gate commands. Reuse `packages/services/src/convex-pack-catalog-publication-client.ts` and P05 HTTP routes rather than creating another transport. Keep schedules/credentials/commands disabled in production.

Consume011's sealed complete build inputs/private evidence/hash association, `BuiltPublicPackSnapshot` and profile envelope; do not recompute economics or modify frontend consumers. Root serializes contract/database/service exports and any required Convex store/schema/generated corrections. Verify the two-provider/two-pack/profile ambiguity and epoch-recovery matrix, including lost responses without an ambiguity marker, gate/lease/hold/seed isolation, then full framework checks. Combined post-merge proof updates and rolls back one pack while another stays byte-identical in the browser.

Drive two packs and one profile through crashes before assembly, after snapshot seal, before send, after an unknown response, during activation, and during protected rollback, then record the exact durable state and recovery outcome at every boundary.

## Objective

Publish and reconcile pack and profile work idempotently while containing failure to the affected entity. Automatic retry and protected per-pack retry, rollback, hold, and resume preserve one complete active pack and keep public reads available even when writers pause.

## Context

P02 owns durable provider-local build requests, sealed snapshot records, activation intents, and publication receipts. P03 turns one fenced build request into a complete deterministic `BuiltPublicPackSnapshot`. P04 owns central shared-change fan-out and provider or collectible profile outboxes. P05 owns authenticated snapshot staging, finalization, atomic heads, and read serving.

Network outcomes can be unknown after a request is accepted, and an expired worker can still hold stale process state. Every exact operation must therefore be persisted before network I/O, reconciled by the same identity after uncertainty, and fenced before any local or public state change. A failed candidate never replaces the current complete head.

## Delivery Context

P06 branches from the updated default branch after P02–P05 and P05A/task011 merge. Its review promise is a complete pack/profile publisher plus protected per-pack recovery commands, all disabled in production after merge. P08 and P09 may consume its status and operating evidence; enabling production schedules or credentials remains outside this task.

## Requirements

### Authorized initial population

- Provide a bounded `seed-pack-catalog` command that accepts the exact ready-included inventory, desired-state cutoff, environment, organization, an active admin holding `pack_catalog:launch`, trusted deployment identity, idempotency identity, and digest.
- Submit included provider and collectible profiles through the P04 profile repositories/outbox first, then included packs through the P02 planner and the same P03–P06 assembly and publication flow used by recurring work; do not create another data path.
- Atomically bind the first accepted seed operation to its launch-plan digest, cutoff, and complete included/excluded inventory before creating work; every pre-success retry must use that exact binding, even after an aborted launch attempt.
- Permit the command only before the first successful P10 launch while recurring claims and schedules remain disabled, and keep it unreachable from browser, public HTTP, and Admin surfaces.

### Idempotent pack and profile publication

- Claim one fenced `PackBuildRequest`, invoke the P03 assembler, then atomically seal or reuse its snapshot and enqueue the distinct P02 activation intent carrying the assigned publication sequence.
- Persist the exact start, batch, finalize, and activate operation identities and request digests before network I/O, then persist verified receipts before completing local work or advancing progress.
- Reconcile status with the same operation identity and bytes after timeout, interruption, or lost response instead of creating altered work.
- Complete an intent when its exact sequence and snapshot are active, acknowledge reused active bytes without changing snapshot identities, and let a greater desired sequence supersede stale unstarted work.
- Publish provider and collectible profile intents from P04 independently, ensuring required initial profile heads are active before the first referencing pack activation.

### Shared-delivery integration

- Claim one P04 `SharedProviderChangeDelivery`, pass it to P02 `ProviderPackImpactPlanner.plan`, and acknowledge P04 only with the exact durable-result digest returned by P02.
- Leave delivery pending when its provider database is unavailable, and continue bounded claims for every healthy provider without reading provider-local membership centrally.
- Reconcile an interrupted or repeated claim by delivery identity, provider-local result digest, and acknowledgment receipt without losing or duplicating logical pack work.

### Automatic retry and isolation

- Retry transient network and service failures with bounded attempts and backoff, while blocking invalid data, authorization, or protected-field failures for only the affected entity.
- Prevent an expired or fenced worker from recording a receipt, success, retry, block, acknowledgment, or checkpoint after a newer claimant owns the work.
- Require the exact current publication epoch for normal activation and stop automatic activation while the pack head is held.
- Leave the prior complete head active after failure at every assembly, staging, finalization, receipt, or activation boundary.
- Poll provider databases, profile outboxes, and pack intents fairly within bounded cycles so one poison item or unavailable provider cannot exhaust worker capacity.

### Protected retry, rollback, and resume

- Retry only a named `waiting` intent with a transient reason or a `retry_scheduled` intent whose provider, stable pack identity, current state, and publication sequence match the command preconditions; permanently invalid `blocked` work remains terminal and source correction creates a new desired request.
- Begin rollback by atomically placing the public pack head on hold and incrementing its publication epoch so every in-flight normal activation under the prior epoch fails; only then update the provider mirror.
- Roll back only to the retained immediately previous complete snapshot while held, without changing another pack or deleting accumulated desired work.
- Continue recording and coalescing desired changes while held. Before resume, read the authoritative public head, repair the provider mirror idempotently, prepare only the latest complete desired snapshot for the current epoch, release the public hold by compare-and-swap, and then mirror the released state.
- Require a non-mutating preview and exact environment, organization, provider, pack, expected state, actor authority, bounded reason, idempotency key, and preview digest for every protected command.

### Recurring-worker gate

- Define one environment-scoped `PackCatalogWorkerGateV1` generation covering recurring provider-change planning, shared fan-out, profile publication, pack assembly, and pack publication claims; it never gates public reads or the separately authorized seed invocation.
- Require every recurring claimant to present the current gate generation before claiming and before committing progress, so a stale claimant cannot continue after the gate changes.
- Support only `disabled`, `draining`, and `enabled`: draining refuses new claims and lets bounded current claims finish or lose their lease, while disabled requires no owned claim remains.
- Change the gate only through the out-of-band release command with compare-and-swap, idempotency, an active admin holding `pack_catalog:launch`, a trusted deployment identity, exact environment/configuration scope, and an immutable receipt.

### Evidence, safety, and availability

- Return the P01 operation outcome plus the resulting `waiting`, `ready`, `publishing`, `retry_scheduled`, `blocked`, `published`, `superseded`, or `rolled_back` work state and bounded current-state evidence.
- Record accepted, refused, repeated, conflicted, and failed automatic or protected operations with sanitized before-and-after identities and actor evidence.
- Expose protected recovery commands only to an active admin holding `pack_publication:recover`, outside browser, public HTTP, and Admin surfaces.
- Keep catalog reads available from current active heads during worker pauses, provider outages, retries, holds, rollbacks, and resume processing.
- Ship workers, schedules, writer credentials, and protected command execution disabled in production, and redact credentials, request bodies, database targets, raw source evidence, snapshot bodies, and stack traces.

## User-Facing Behavior

Automatic retry causes no visible change until a complete snapshot activates. A failed candidate leaves the current pack readable, rollback changes only the named pack to its previous complete snapshot, a held pack stays stable, and every unrelated pack remains available and can continue publishing.

## Interface Contract

`ProviderPackPublisher.publishClaimedBuild` consumes `ProviderPackBuildRequestRepository`, `ProviderPackSnapshotAssembler`, `ProviderPackSnapshotRepository`, `ProviderPackPublicationOutboxRepository`, and `ConvexPublicPackPublicationClient`. It returns one stable publication outcome and records all operation and receipt evidence through the fenced P02 repositories.

`CentralProfilePublisher.publishClaimedProfile` consumes P04 `ProfilePublicationEnvelope` values through `CentralProfilePublicationOutboxRepository` and calls the exact P05 start, batch, finalize, activate, status, and block profile operations through `ConvexPublicProfilePublicationClient`. The envelope supplies the identity, descriptor, ordered batches, payload digest, intent, and scope; provider profiles use provider scope and collectible profiles use catalog scope, and profile work follows the same operation and receipt rules without taking a pack lease.

`SharedPackFanoutWorker` consumes P04 `SharedPackFanoutRepository`, passes each `SharedProviderChangeDelivery` to P02 `ProviderPackImpactPlanner.plan`, and returns only the exact acknowledgment identity and result digest. It cannot query provider membership itself.

The public-store clients mirror P05 status, start, batch, finalize, activate, block, `holdPublicPackHead`, `activateRetainedPublicPackSnapshot`, and `resumePublicPackHead` operations. Every request and receipt binds environment, authorization scope, entity, stable identity, snapshot, operation identity, request digest, expiry, and publication sequence or epoch where applicable.

Protected `retry-pack-publication`, `rollback-pack-snapshot`, and `resume-pack-publication` commands accept the exact preview digest and command preconditions. They return `applied`, `already_applied`, `refused`, or `conflict` plus bounded current-state evidence and immutable sanitized audit identity.

The protected `seed-pack-catalog` command uses the same planner and publisher contracts for a fixed launch inventory while recurring claims remain disabled. Its first accepted receipt durably fixes the launch-plan digest, cutoff, and full included/excluded inventory for every pre-success retry; a mismatch is refused without work. A crash after a public hold or resume transition but before the provider mirror write leaves the public head authoritative and the provider side conservatively quiet until reconciliation repairs the mirror.

`PackCatalogWorkerControl.setGate({ expectedGeneration, targetState, environment, configurationDigest, cutoff?, idempotencyKey })` is an out-of-band release operation that returns the resulting `PackCatalogWorkerGateV1` and an immutable per-worker-family drain or enable receipt. It is unreachable from browser, public HTTP, and Admin routes. A changed generation conflicts without mutation; an exact replay returns the original receipt.

## Acceptance Criteria

### Initial population

- [ ] The seed command accepts only the exact authorized ready-included inventory and desired-state cutoff before first successful launch.
- [ ] Repeated seed invocation converges through the normal planner and publisher without duplicate logical work or a separate publication path.
- [ ] The first accepted seed fixes one launch-plan digest, cutoff, and full inventory; every changed pre-success retry or later aborted-attempt inventory is refused before mutation.
- [ ] Browser, public HTTP, Admin, post-launch, non-admin, missing-`pack_catalog:launch`, untrusted-deployment, wrong-scope, and changed-digest seed attempts fail without mutation.

### Publication convergence

- [ ] Failures before assembly, after seal and intent commit, before send, after a lost response, after receipt persistence, and after activation converge to one logical publication.
- [ ] Exact desired-head outcomes complete idempotently, reused bytes advance only sequence and receipt evidence, and greater sequences supersede stale work safely.
- [ ] Lease loss prevents every later state transition by the expired worker.
- [ ] A profile failure, poison pack, or unavailable provider does not delay independent healthy pack or profile work.
- [ ] Every failed candidate leaves only the prior complete active head readable.

### Shared-delivery convergence

- [ ] A claimed delivery is acknowledged only after every affected provider-local pack has a durable build request or no-change result.
- [ ] An unavailable provider leaves its delivery pending while healthy providers continue through planning and publication.
- [ ] Interruption and repeated delivery converge by identity and result digest without duplicate logical pack work.

### Recovery behavior

- [ ] Repeated manual retry of eligible transient work produces one latest-desired intent and returns the original stable outcome, while `blocked`, terminal, or unknown-state retry is refused without mutation.
- [ ] Holding the head fences every prior-epoch publisher before rollback can select the previous complete snapshot.
- [ ] Desired changes accumulate while held, and resume publishes only the latest complete desired state under the current epoch.
- [ ] A crash after public hold or resume compare-and-swap but before provider mirroring stays safe and repairs the mirror idempotently before normal work continues.

### Authorization

- [ ] Wrong environment, organization, provider, pack, authority, expected state, or preview digest fails closed without changing the head or hold.
- [ ] A non-admin or actor missing `pack_publication:recover` cannot invoke recovery; browser, public API, and Admin requests cannot reach commands or receive their credentials and evidence.
- [ ] An operation outside the 30-day replay window returns `OPERATION_EXPIRED`, performs no mutation, and cannot be recreated as new work under a changed identity.

### Worker-gate safety

- [ ] Every recurring worker refuses a new claim under `draining` or `disabled`, and stale-generation workers cannot commit progress.
- [ ] Transition to `disabled` completes only after every bounded in-flight claim finishes or is fenced by lease loss; public reads remain available throughout.
- [ ] Wrong actor, permission, deployment identity, environment, configuration digest, expected generation, or replay identity fails without changing the gate.
- [ ] Exact gate-command replay returns the original receipt, and only the separately authorized seed invocation can run while recurring work is disabled.

### Availability and safe merge

- [ ] Public reads remain available and coherent while all writers are paused and throughout retry, hold, rollback, and resume races.
- [ ] Another pack continues publishing while the named pack is retrying, blocked, held, or rolled back.
- [ ] Logs, metrics, receipts, command output, and errors contain no secrets, raw payloads, database targets, snapshot bodies, or stack traces.
- [ ] Worker polling and automatic retry meet declared bounds under poison work and unavailable-provider fixtures.
- [ ] Merging P06 leaves every production worker, schedule, writer credential, and protected command disabled.

## Verification

Named scenario: **Publication ambiguity and epoch-fenced recovery matrix** — run two providers, multiple packs, and provider or collectible profiles through every crash, timeout, lease-loss, retry, block, hold, rollback, resume, conflict, and unauthorized boundary while proving deterministic convergence, complete reads, and independent progress.
