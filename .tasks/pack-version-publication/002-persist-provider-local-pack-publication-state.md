# Task: Persist Provider-Local Pack Publication State

**ID:** pack-version-publication/002
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006
**Delivery phase:** P02
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder after P01, including provider-schema, planning, readiness, isolation, and crash-boundary verification
**Status:** todo

## Start Here

Build a change-to-pack fixture for two isolated providers, then record the exact local pack requests, no-op outcomes, sequences, readiness decisions, and checkpoint state when one provider is unreachable.

## Objective

Give each provider database one durable, isolated publication state machine that maps canonical and delivered shared changes to sequenced, fully pinned pack build requests. Invalid or incomplete work remains local to its pack while independent packs and providers continue progressing.

## Context

Provider databases are authoritative for their own pack metadata, contents, odds, lifecycle, calculation inputs, and publication history. Exact affected packs can be identified only against provider-local membership, including when a centrally owned collectible, category, alias, display, or valuation change arrives.

Planning must be durable before source progress advances. A request that is merely held in worker memory can disappear after a crash, while a request built from mutable rows can assemble a state different from the one that was admitted. Each durable `PackBuildRequest` therefore owns a provider-local sequence and immutable input identities before assembly begins.

This task owns provider persistence, impact planning, readiness, artifact sealing, activation intents, receipts, and progress. It does not assemble snapshot bytes, publish profiles, contact the public store, or change a public head.

## Delivery Context

P02 branches from merged P01 and may be built alongside P03, P04, and P05. Its review promise is complete provider-local planning and crash-safe persistence with every processor and schedule inactive. After merge, provider records may be exercised by tests, but no public catalog data or user-visible behavior changes; P06 consumes this state after its other prerequisites are complete.

## Requirements

### Impact planning

- Map pack metadata, price, lifecycle, odds, content membership, content snapshots, and EV inputs or results to the owning `publicRepackId`.
- Accept immutable shared collectible, category, alias, display, and valuation deliveries and expand exact affected pack identities only against provider-local membership.
- Include every pack containing an eligible collectible whose valuation change can alter chase selection, even when that collectible was not previously top chase.
- Keep provider and collectible profile publication independent; enqueue pack work only when shared fields sealed inside a pack snapshot change.
- Ignore pulls, Heat, provider health, worker state, activity, saves, user records, and any data outside the P01 snapshot boundary.

### Readiness and desired state

- Allocate one provider-local monotonic `packPublicationSequence` when each distinct desired pack state becomes a durable `PackBuildRequest`.
- Require stable native identities, complete contents, valid probability coverage, every eligible member's display/category/valuation identities, matching EV input and result identities, and named initial profile prerequisites.
- Admit explicit domain EV `unavailable`; classify missing, failed, expired, or input-mismatched calculation work as `waiting` with a retryable reason.
- Classify permanently invalid source state as `blocked`, represented current state as `no_change`, and older unclaimed work replaced by a greater sequence as `superseded`.
- For lifecycle-only work, pin the complete prior snapshot plus lifecycle provenance and EV presentation or freeze inputs; return `waiting` when no complete baseline exists.

### Durable provider records

- Persist sequenced build requests, immutable sealed snapshots, distinct activation intents, operation digests, verified receipts, attempts, and bounded progress in the owning provider database.
- Atomically seal or reuse an assembled snapshot, complete the fenced build request, create a distinct activation episode, and enqueue an intent carrying the request's local sequence.
- Reuse byte-identical artifacts by stable pack identity and content hash, but never reopen a completed, superseded, or rolled-back activation intent.
- Store the provider-side mirror of the public head's publication epoch and hold state for quiet scheduling while treating the public head as the activation authority.
- Preserve provider publication history independently of public-store retention and keep canonical EV calculation work as the sole EV work authority.

### Isolation, leases, and progress

- Prevent one provider database from reading, leasing, mutating, acknowledging, or checkpointing another provider's records.
- Serialize claimed build and activation work for the same pack while allowing unrelated packs from the same or different providers to progress independently.
- Fence leases so an expired claimant cannot complete, retry, block, supersede, acknowledge, or record a receipt after a newer claim exists.
- Advance a provider change boundary only after every affected local pack has a durable sequenced request or a durable no-op for the exact desired identity.
- Acknowledge a delivered shared shard only after every affected local pack is durably represented; provider unavailability leaves the delivery pending at its source.

### Failure and security behavior

- Recover after crashes before request commit, after request enqueue, during assembly ownership, at seal-and-intent commit, and before or after receipt persistence.
- Reject organization, provider, pack, dependency, source-boundary, EV-input, activation-epoch, and lease-fence mismatches before mutation.
- Allow a greater local sequence to supersede older unclaimed desired work without deleting its reason, source identities, or audit history.
- Bound claim batches, leases, attempts, retry times, reason text, operation history, query pages, and retained evidence so one poison pack cannot exhaust a worker cycle.
- Exclude credentials, database targets, authorization material, raw payloads, source evidence, stack traces, exact collectible instances, and user data from publication records and logs.

## User-Facing Behavior

There is no direct user-facing change. The resulting state machine ensures that an incomplete or invalid candidate leaves its pack unchanged and cannot delay another ready pack or a pack owned by another provider.

## Interface Contract

`ProviderPackImpactPlanner.plan` accepts either a provider-local canonical change page or the P01 `SharedProviderChangeDelivery` addressed to this provider. It returns affected stable pack identities and atomically persisted `PackBuildRequest` or exact no-op outcomes plus an acknowledgment digest without contacting the public store.

`ProviderPackReadinessEvaluator.evaluate` returns `ready`, `waiting`, `blocked`, `no_change`, or `superseded`, an exact desired-input identity, pinned source and dependency identities, initial profile prerequisites, and a bounded stable reason. Only `ready` work can be claimed for assembly.

`ProviderPackBuildRequestRepository` durably enqueues, coalesces, claims, renews, completes, blocks, and supersedes build work under provider, stable pack identity, local sequence, lease fence, and expected prior state.

`ProviderPackSnapshotRepository.sealAndEnqueueActivation` accepts one fenced build request and one validated `BuiltPublicPackSnapshot`. It atomically returns the existing byte-identical sealed snapshot or a newly committed snapshot plus a distinct activation intent carrying the request sequence.

`ProviderPackPublicationOutboxRepository` exposes bounded claim, renew, record-operation, record-receipt, retry, block, supersede, and complete outcomes. Every mutation binds provider, `publicRepackId`, activation intent, lease fence, idempotency key, request digest, and expected prior state.

## Acceptance Criteria

### Impact and readiness

- [ ] Direct pack, contents, odds, lifecycle, and EV changes enqueue every and only owning packs.
- [ ] A shared dependency delivery expands locally to every and only affected pack, including a non-top eligible collectible that becomes top chase.
- [ ] Complete matched inputs produce `ready`; partial contents, invalid odds, stale dependencies, and technical EV failures cannot produce it.
- [ ] Valid EV-unavailable work is ready, permanently invalid domain data is blocked, and a missing lifecycle baseline waits safely.
- [ ] Pulls, Heat, health, activity, profiles outside sealed pack fields, saves, and user records produce no pack work.

### Persistence and isolation

- [ ] Planning and local sequence allocation commit together before provider or shared-delivery progress advances.
- [ ] Sealing and activation enqueue either commit together or leave the fenced build request safely retryable.
- [ ] Same-pack claims serialize while two unrelated packs can be claimed concurrently.
- [ ] Organization and provider mismatch tests directly refuse cross-provider access.
- [ ] One unreachable provider leaves its delivery durable without preventing another provider's local planning.

### Recovery and bounded behavior

- [ ] Crash, duplicate delivery, lost lease, and receipt-before-completion cases converge without lost or duplicate logical publication.
- [ ] An expired claimant cannot mutate work after a newer fence is issued.
- [ ] Byte-identical artifacts reuse one sealed snapshot while later activation episodes keep distinct immutable intents and sequences.
- [ ] A newer local sequence supersedes stale unclaimed work while preserving bounded audit evidence.
- [ ] Records, logs, and errors stay within declared bounds and contain no protected data.

## Verification

Named scenario: **Provider-local planning and persistence crash matrix** — drive direct and shared changes through two isolated provider databases, every readiness outcome, concurrent pack claims, an unreachable provider, and every durable commit boundary.
