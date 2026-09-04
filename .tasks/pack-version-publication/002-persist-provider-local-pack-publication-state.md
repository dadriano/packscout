# Task: Persist Provider-Local Pack Publication State

**ID:** pack-version-publication/002
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006
**Delivery phase:** P02
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder after P01, including provider-schema, planning, readiness, isolation, and crash-boundary verification
**Status:** done

## Current checkpoint — 2026-09-04

PR109 is released. PR113 advanced main to `8125934bb39338f73501ac1bc9fef8950d462746`, the direct parent. P02 implementation `b5482a96570f71de46d2c87d849e2b3e11bcce2c` includes the canonical-admission, actual public-store outcome, and large-lifecycle capacity repairs. **118 focused checks and 30 schema checks pass, zero skips**, along with affected lint/types, docs, and the zero-finding standards ratchet. The 13 existing signed Convex public-store tests also passed. Task acceptance is complete; the final capacity change still requires current-head full local/CI certification before merge.

The predecessor `486c68aa` passed both the full local verifier and [CI33890801868](https://github.com/dadriano/packscout/actions/runs/33890801868). Its four remaining review threads are resolved. Only the latest lifecycle-capacity discussion remains open pending full certification. Its genuine red regression is `/tmp/packscout-p02-lifecycle-capacity-red-direct-20260904.log`; the corrected 6,000-member pack stores and reloads its complete baseline, seals the lifecycle update, and leaves the next pack pageable. Capture and baseline each retain a 16 MB limit; only their combined JSONB storage allowance grows, to 36 MB including formatting headroom. No public snapshot, batch, or request limit is relaxed.

P03 remains local and waits for the actual PR95 merge. Restack from exact old P02 boundary `8409143c8cca71e63602e097adf3e8ba45d86a12`, align/certify/publish separately, and do not merge it. No publisher, public head, PR113 deployment, or later phase is activated here.

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

- [x] Direct pack, contents, odds, lifecycle, and EV changes enqueue every and only owning packs.
- [x] A shared dependency delivery expands locally to every and only affected pack, including a non-top eligible collectible that becomes top chase.
- [x] Complete matched inputs produce `ready`; partial contents, invalid odds, stale dependencies, and technical EV failures cannot produce it.
- [x] Valid EV-unavailable work is ready, permanently invalid domain data is blocked, and a missing lifecycle baseline waits safely.
- [x] Pulls, Heat, health, activity, profiles outside sealed pack fields, saves, and user records produce no pack work.

### Persistence and isolation

- [x] Planning and local sequence allocation commit together before provider or shared-delivery progress advances.
- [x] Evaluation cannot replace transaction-captured data; only shared schema/order/stored-baseline normalization is allowed, and admission persists a private copy across awaits.
- [x] Captured-input digests are recomputed at admission, and shared identities/sequences are validated against their actual database representations before planning.
- [x] Direct admission rejects noncanonical contents, action, or alias ordering even when supplied digests match those raw bytes; the shared evaluator still admits its normalized capture.
- [x] The exact sorted provider/member profile prerequisites are derived from captured inputs; substituted, missing, extra, and empty declarations refuse before writes.
- [x] Sealing and activation enqueue either commit together or leave the fenced build request safely retryable.
- [x] Sealing recomputes the canonical economics digest and rejects a coherently rehashed artifact with forged economics evidence before any writes.
- [x] Same-pack claims serialize while two unrelated packs can be claimed concurrently.
- [x] Organization and provider mismatch tests directly refuse cross-provider access.
- [x] One unreachable provider leaves its delivery durable without preventing another provider's local planning.

### Recovery and bounded behavior

- [x] Crash, duplicate delivery, lost lease, and receipt-before-completion cases converge without lost or duplicate logical publication.
- [x] Public-store already-active receipts complete without an invented generation increment; same-generation resume/status observations preserve monotonic sequence and lease fencing.
- [x] Definitive public-store conflicts/refusals release newer desired work regardless of the snapshot's ready/published/waiting state, while unknown/successful/expired activation results remain protected.
- [x] An expired claimant cannot mutate work after a newer fence is issued.
- [x] Byte-identical artifacts reuse one sealed snapshot while later activation episodes keep distinct immutable intents and sequences.
- [x] A newer local sequence supersedes stale unclaimed work while preserving bounded audit evidence.
- [x] A 6,000-member lifecycle request persists its complete pinned baseline, seals, and leaves the following pack pageable; neither capture nor baseline can borrow the other's 16 MB allowance.
- [x] Records, logs, and errors stay within declared bounds and contain no protected data.

## Verification

Named scenario: **Provider-local planning and persistence crash matrix** — drive direct and shared changes through two isolated provider databases, every readiness outcome, concurrent pack claims, an unreachable provider, and every durable commit boundary.

## Implementation and Spec Compliance

### Current delivery status

Implementation `b5482a96` on parent `8125934b` passes 118 focused checks, 30 schema checks, and affected static gates. Predecessor486c68aa passed full local and CI; its 34 reviewed findings are resolved. The capacity finding is repaired and awaits final full certification. PR95 is not merged; P06 owns external-write E2E.

### Implemented invariants and review corrections

- Native and shared impact expansion uses transaction-local membership, bounded keyset pages, hash-chained receipts, and acknowledgment only after every affected pack has durable work or an exact current no-op.
- Captured bytes are schema-normalized and preserved before evaluator callbacks. Admission compares the complete capture and persists a private copy, including across later database awaits.
- Admission independently derives every input digest, the exact sorted profile prerequisite set, and readiness outcome/reason from preserved bytes and database time. The pure V1 decision rules are shared with the service evaluator; no database-to-service dependency or duplicated rule set is introduced.
- Native shared identities use UUIDs; shared delivery sequences fit signed PostgreSQL bigint. Public action/member-profile/eligible-valuation identities are unique. Complete normalized search text, aliases, and category sets must fit the public projection schema at readiness and independent admission; overflow blocks without dropping contents.
- Canonical captures retain the 16,000,000-byte limit. Shared progress, requests, intents, and operations allow 18,000,000 JSONB bytes for formatting headroom. Full 10,000-item multibyte dependency evidence survives paging and exact replay.
- Lifecycle-only requests pin the stored active artifact and preserve complete metadata, `dataAsOf`, contents, profiles, display, and economics. Admission and sealing independently reject forged lifecycle metadata or timestamps, even with coherently rehashed evidence. Sealing recomputes the full economics tuple before persistence.
- Coalescing applies only to the latest compatible episode. A→B→A and replacement of superseded work allocate new sequences without reopening terminal rows. The unapplied V1 migration no longer globally uniquifies desired digests across history.
- Database-time readiness participates in coalescing. Future-dated EV becoming valid creates a fresh claimable sequence from unchanged input bytes, even when the evaluator hints `no_change`; expired EV records one waiting episode. Repeated unchanged waiting/ready work coalesces, and an already materialized blocked command keeps its attempt budget rather than being reset by source reevaluation.
- `accepted_sequence` is distinct from the newest desired sequence. Immutable operations and receipts, not an optional ambiguity marker, determine reconciliation hazards. Missing/mismatched receipts, successful activation, and expired activation replay survive enqueue, lease takeover, defer, and attempt exhaustion below newer desired work. Blocked unresolved work pauses only its own pack; definitive refusals permit corrected input to advance. Conflicting authoritative epochs/heads fence incompatible owners.
- Sealing rechecks readiness at database time. Queued EV expiry durably becomes `waiting / EV_INPUTS_PENDING`, releases its lease, and produces no artifact or intent.
- An expired intent with zero operations or partial start/batch/finalize work can retire only after every recorded operation proves non-activation under the current lease. `retireReconciled` preserves operation/receipt bytes and replans only the latest expired desired capture. Still-valid evidence can reuse the artifact; expired EV waits for fresh inputs. Unknown/successful activation and expired activation replay remain protected. Retirement, replacement, and lease release roll back together on persistence failure; older expiry never replaces newer desired work.
- Scoped foreign keys, immutable operation/receipt evidence, fenced claims, bounded attempts, and explicit local runtime grants preserve provider/organization isolation. No transport, scheduler, or public activation is added.

The earlier fixes address discussions `3930457571`, `3930457576`, `3930457580`, and `3930580327`. The 2026-09-04 correction also covers `3930633635` (crash before an ambiguity marker), `3930633637` (partial execution expiry), `3933224053` (future-dated EV never becoming claimable), and `3933383209` (lifecycle `dataAsOf` forgery). The complete 106-test cumulative matrix and 30 schema checks pass with no skips; affected lint/typechecks and the zero-finding ratchet pass. Evidence: `/tmp/packscout-p02-after-p05-green-20260904.log`; the three database-time regressions have a bounded red reproduction in `/tmp/packscout-p02-readiness-transition-red-20260904.log`. Full certification and GitHub thread closure remain pending; do not infer merge readiness from the focused checks.

### Intentional adaptations and later owners

Related guidance reviewed: feature `tech-001` through `tech-005`, with P02 implementation centered on `tech-002`.

- Separate provider clients, the bounded gateway, and immutable database identity already exist; no PR66 adapter needs to be ported.
- P05's merged contract narrows pack search text to normalized title plus aliases. Readiness now uses its shared `packSearchText` helper and canonical `pack-catalog-v1` fixture export. Full contents remain mandatory and independently discoverable through exact membership/collectible reads; long member names no longer spuriously block pack search. P03 must adopt the same rule when restacked. No technical spec was rewritten.
- The existing transactional `promotion_changes` ledger protects canonical source progress. Publication owns a separate checkpoint and moves it only after durable outcomes; no notification dependency or second EV queue is added.
- `PackInputCapture` is a transaction-bound composition port. P06 binds native/P04 readers through its supplied transaction, without network calls, EV recalculation, or lazy sealing reads.
- Missing prerequisites retain sequenced waiting/blocked evidence without a claimable assembly command. Protected or malformed captures retain only bounded identity/reason markers, not rejected payloads.
- P04 delivers shared shards in increasing provider sequence, resumes `complete: false` pages, and retries exact identities after lost responses. Incomplete boundaries have no acknowledgment digest.
- Coalescing includes publication epoch, so hold/resume can prepare a new episode for identical bytes. Native change-boundary identities also distinguish source observations.
- The per-pack build/activation lease uses a deferred scoped SQL reference guard. Public head reads are authoritative; the local head remains only a scheduling/reconciliation mirror.
- Polling durable state is sufficient; no wake table or notification processor is introduced while dormant.
- P03 owns pure assembly, P04 owns shared/profile production, and P06 owns authenticated transport, worker scheduling, operation-status reconciliation, and cumulative runtime activation.

### Automated evidence

| Acceptance area | Evidence |
|---|---|
| Complete/missing/invalid inputs, explicit EV unavailability, pending/technical/expired EV, lifecycle freeze, protected fields | `packages/services/src/provider-pack-readiness-evaluator.test.ts` |
| Direct/shared membership, crash boundaries, atomic sealing, immutable replay, independent providers, 251-pack paging, lease and hold/epoch fencing | `packages/services/src/provider-pack-publication.integration.test.ts` |
| Captured authority, false-ready refusal, maximum shared evidence, duplicate IDs, A→B→A, accepted/ambiguous receipt recovery below newer work, EV and unused-intent expiry | `packages/services/src/provider-pack-publication-boundaries.integration.test.ts` |
| Role inventory, scoped references, immutable episodes, migration/schema consistency | `packages/database/prisma/distributed-schema-contract.test.ts` and migrated provider databases |

Current implementation `b5482a96`: **118 focused checks pass, zero skips**, `/tmp/packscout-p02-lifecycle-capacity-focused-20260904.log`. All 30 schema checks, affected contracts/database/services lint and types, docs, and the zero-finding ratchet pass. The 13 existing signed Convex public-store tests passed on the unchanged public store (`/tmp/packscout-p02-public-store-results-convex-20260904.log`), without claiming P06's combined transport E2E.

The capacity red log is `/tmp/packscout-p02-lifecycle-capacity-red-direct-20260904.log`. The new PostgreSQL capacity test covers independently bounded full capture and baseline, combined JSONB storage above the old 18 MB ceiling, actual page bytes, immutable reload, lifecycle seal, and subsequent independent-pack progress. Full current-head certification targets `/tmp/packscout-p02-lifecycle-capacity-framework-20260904.log`. Predecessor486c68aa passed full local and CI33890801868; earlier interrupted/superseded runs are not current passes. Local TSX cache is disabled and Vitest uses two workers with owned private PostgreSQL; no gate or timeout is weakened.

There is no browser acceptance surface in this dormant phase. No manual environment deployment or publication activation is performed; P06 owns the later runtime integration.

### Earlier review repair history — 2026-09-04

Discussions `3933953815` and `3933953820` are implemented in `b34e50b7`, included in the certified current-parent head. `listOperations(claim)` exposes at most 100 deterministically ordered metadata records (operation ID, request digest, receipt presence), protected by the current activation lease and tenant scope. P06 discovers these IDs after reclaim, reads each exact command through `readOperation`, and reconciles/replays its persisted bytes; it must not generate a replacement UUID for an existing command. Listing never materializes the potentially large captured intent per row.

Authenticated remote receipts retain their exact completion timestamp with a documented ±60,000 ms cross-host skew allowance relative to operation creation/local receipt time. This does not relax request-digest binding, byte-exact receipt replay, lease ownership, or tenant isolation. Tests cover both exact skew boundaries, one millisecond outside each, changed digest/receipt rejection, stale/foreign leases, crash discovery without the original UUID, 100 bounded metadata rows, and overflow refusal.

Current cumulative focused evidence: **108 passed, zero skips**, `/tmp/packscout-p02-discovery-skew-focused-20260904.log`; red reproduction `/tmp/packscout-p02-operation-discovery-skew-red-confirmed-20260904.log`. Contracts/database/services lint and typechecks pass. The initial skew fixture attempted to modify immutable operation creation time; it was corrected to read the stored timestamp without altering evidence before recording the genuine red reproduction. The current-parent full local certification above supersedes this earlier focused checkpoint. This is not permission to merge P03 or activate publication.

Discussion `3930060751` also has direct admission regression cases for captured EV pinned before changes to price, valid total-preserving odds, valuation amount, method, or policy. The injected evaluator falsely reports ready with newly recomputed digests; the existing independent admission decision rejects every case without request/head/progress writes. The focused authority suite passes all 7 tests, zero skips (`/tmp/packscout-p02-stale-ev-admission-20260904.log`). This expands evidence for the existing fix; no runtime change or new EV calculation was introduced. These cases are included in the current-parent passing cumulative and full local certification.
