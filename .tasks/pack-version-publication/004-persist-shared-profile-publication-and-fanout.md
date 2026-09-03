# Task: Persist Shared Profile Publication and Fan-Out

**ID:** pack-version-publication/004
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006
**Delivery phase:** P04
**Estimated scope:** medium
**Estimated effort:** 1.5–2 days for one builder after dependencies are complete, including crash, isolation, and offline-provider verification
**Status:** todo

## Start Here

Define one fixture where a shared collectible change affects packs in two providers, make one provider unavailable, and record the exact durable shard, local expansion, profile intent, checkpoint, and initial-head results expected for both providers.

## Objective

Persist centrally owned shared changes and provider or collectible profile publication as durable provider-scoped work. A provider that cannot be reached retains its work without delaying any healthy provider or weakening the initial profile-head requirements for a pack.

## Context

Collectible display data, categories, valuations, and aliases are centrally owned but can affect pack snapshots stored in isolated provider databases. The central service must capture the complete provider audience before advancing source progress, while each provider remains responsible for determining the exact affected packs from its own membership data.

Provider and collectible profiles are immutable public entities with independent active heads. The first publication of a pack requires an active provider profile and active collectible profiles for every referenced collectible; later profile changes publish independently and do not alter an already sealed pack snapshot.

## Delivery Context

P04 is a sibling of P02, P03, and P05 from merged P01. Its review promise is durable central fan-out, immutable profile snapshots, and profile outboxes with processing disabled in production. After merge, no source schedule, writer credential, public route, profile head, or pack head is activated; P06 consumes the completed contracts after P02–P05 merge.

## Requirements

### Durable shared-change fan-out

- Persist each accepted shared change with its immutable source identity, dependency identities, content digests, and the complete bounded set of in-scope providers.
- Atomically create one ordered, bounded shard for every in-scope provider before recording the central source checkpoint as durable.
- Expose each shard as the exact P01 `SharedProviderChangeDelivery` only to its addressed provider; the central service never queries provider-local membership or creates pack build requests.
- Accept acknowledgment only with the delivery identity and digest returned after P02 has durably represented every locally affected pack as a build request or exact no-change result.
- Keep an unavailable provider's shard pending and retryable while healthy providers expand, acknowledge, and continue independently.

### Profile snapshots and initial heads

- Persist complete immutable provider and collectible profile snapshots with stable public identities, deterministic bytes, content digests, source identities, and bounded evidence.
- Reuse byte-identical profile snapshot artifacts while creating a distinct activation intent and audit episode for every later request to publish those bytes.
- Persist provider-profile and collectible-profile outbox work before any public-store request, then reconcile the same operation identity after ambiguous network outcomes.
- Ensure the initial provider profile and every initially referenced collectible profile are ready to publish before a first pack activation can succeed.
- Let later provider or collectible profile publication proceed independently from all pack heads and from every other profile head.

### Recovery, progress, and security

- Use fenced leases and idempotency identities so an expired worker cannot acknowledge, retry, block, or complete work after ownership changes.
- Advance central source progress after the full provider shard set and required profile work are durable, without waiting for provider delivery or acknowledgment.
- Recover after interruption before shard commit, after checkpoint commit, during provider expansion, before network send, and after an unknown response without lost or duplicated logical work.
- Bound provider snapshots, shards, expansion pages, attempts, reason text, operation history, and retained payload evidence.
- Reject cross-organization, cross-provider, changed-byte, expired-authorization, and browser-originated mutations while redacting credentials, database locations, raw payloads, and stack traces.

## User-Facing Behavior

There is no buyer or Admin interface change. A healthy provider can continue preparing pack and profile state while another provider is unavailable, and no incomplete profile work becomes publicly reachable.

## Interface Contract

`SharedPackFanoutRepository` persists the source change, immutable dependency vector, complete provider snapshot, ordered provider shards, fenced delivery state, attempts, stable outcomes, and central checkpoint receipt. It claims one `SharedProviderChangeDelivery` for its addressed provider and acknowledges only the exact delivery identity plus P02 result digest. Source progress completes when every required shard and profile intent is durable, not when providers finish processing them.

P02 `ProviderPackImpactPlanner.plan` consumes the delivery and owns provider-local expansion, durable build requests, and no-change outcomes. P04 defines and persists the delivery boundary but does not implement or call the provider planner.

`ProviderProfileSnapshotRepository` and `CollectibleProfileSnapshotRepository` seal or reuse the P01 `PublicProviderProfile` or `PublicCollectibleProfile` payload, identity, descriptor, and ordered batches, then create a distinct `ProfileActivationIntent`. `CentralProfilePublicationOutboxRepository` claims the resulting `ProfilePublicationEnvelope`, renews it, records exact operations and receipts, retries, blocks, supersedes, and completes its independent intent.

P05 supplies the authenticated public profile storage and atomic heads. P06 consumes the profile outboxes and must publish required initial profile heads before attempting a first referencing pack activation.

## Acceptance Criteria

### Fan-out durability and isolation

- [ ] A shared change records the complete provider set and every provider shard before its source checkpoint advances.
- [ ] A shard claim returns the exact provider-scoped delivery, and acknowledgment accepts only the identity and durable-result digest produced after P02 provider-local expansion.
- [ ] One unavailable provider retains retryable work while every healthy provider continues without waiting for it.
- [ ] Interrupted, repeated, and fenced-out delivery converges without missing or duplicate logical pack work.
- [ ] No provider can read, claim, acknowledge, or mutate another provider's shard, and the central service never reads provider-local membership.

### Profiles and recovery

- [ ] Provider and collectible profile snapshots are complete, immutable, deterministic, and reusable by content digest while activation intents remain distinct.
- [ ] Initial profile work is available before the first referencing pack activation, and later profile updates do not change sealed pack bytes.
- [ ] Lost responses and repeated outbox delivery reconcile the original operation and converge to one logical profile activation.
- [ ] Central progress never waits for provider acknowledgment after all required shards and profile intents are durable.
- [ ] Records, logs, errors, and receipts expose no credentials, raw source payloads, database locations, or cross-organization data.

## Verification

Named scenario: **Offline-provider fan-out and initial-profile recovery** — process one shared change and two profile changes across two providers, interrupt every commit and receipt boundary, keep one provider unavailable, and prove exact local expansion, independent healthy progress, fenced recovery, and complete initial profile prerequisites.
