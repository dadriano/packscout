# Task: Persist Provider-Local Pack Publication State

**ID:** pack-version-publication/002
**Depends on:** pack-version-publication/001
**Blocks:** pack-version-publication/006
**Delivery phase:** P02
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder after P01, including provider-schema, planning, readiness, isolation, and crash-boundary verification
**Status:** in_progress

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
- [x] Captured-input digests are recomputed at admission, and shared identities/sequences are validated against their actual database representations before planning.
- [x] Sealing and activation enqueue either commit together or leave the fenced build request safely retryable.
- [x] Sealing recomputes the canonical economics digest and rejects a coherently rehashed artifact with forged economics evidence before any writes.
- [x] Same-pack claims serialize while two unrelated packs can be claimed concurrently.
- [x] Organization and provider mismatch tests directly refuse cross-provider access.
- [x] One unreachable provider leaves its delivery durable without preventing another provider's local planning.

### Recovery and bounded behavior

- [x] Crash, duplicate delivery, lost lease, and receipt-before-completion cases converge without lost or duplicate logical publication.
- [x] An expired claimant cannot mutate work after a newer fence is issued.
- [x] Byte-identical artifacts reuse one sealed snapshot while later activation episodes keep distinct immutable intents and sequences.
- [x] A newer local sequence supersedes stale unclaimed work while preserving bounded audit evidence.
- [x] Records, logs, and errors stay within declared bounds and contain no protected data.

## Verification

Named scenario: **Provider-local planning and persistence crash matrix** — drive direct and shared changes through two isolated provider databases, every readiness outcome, concurrent pack claims, an unreachable provider, and every durable commit boundary.

## Implementation and Spec Compliance

### Captured authority and evidence capacity review — 2026-09-03

Discussions `3929985053`, `3929985060`, `3929985062`, and `3929985065` exposed boundary cases in lifecycle admission, evaluated identities, and JSONB evidence capacity. The new real-PostgreSQL boundary suite first failed all three scenarios. Lifecycle readiness now pins only the stored active artifact supplied as `previousSnapshot`; a caller-supplied baseline with no active artifact remains `waiting` and unclaimable. Impact planning isolates delivered dependency evidence from callback mutation and rechecks evaluated provider, pack, source revision, and dependencies against the original boundary before enqueueing or checkpointing.

Request, intent, and operation JSONB bounds now use the same bounded 18,000,000-byte storage allowance as captured inputs (16 MiB canonical admission plus JSONB formatting headroom). This preserves the existing 10,000-dependency contract rather than rejecting valid evidence later in persistence. The regression carries 10,000 maximum-length multibyte named dependencies through admission, sealing, outbox recording, and exact replay; no public-store call or processor is enabled.

The preceding implementation `f699d11b0f98c4873826b222ce0f00d9f58c3f12` passed the complete unchanged `npm run verify:framework`, including npm audit, the 5,000-record database maximum, every test lane, and both production builds. That result supersedes the historical audit/volume failures below, but does not certify these newer corrections or the refreshed main parent. Current task status remains `in_progress` until their full gate passes.

The new combined contract/readiness/PostgreSQL regressions pass 54 checks with zero skips, including maximum-length multibyte dependency evidence. Database/service lint and typechecks, the zero-finding standards ratchet, and documentation checks pass. Current full-gate verification is being repeated after the parent refresh.

### Additional review corrections — 2026-09-03

Discussions `3929802770`, `3929802774`, and `3929904797` are covered by red/green regressions. UUID-resolved shared category/collectible/valuation identities now use the native UUID contract (including lowercase normalization), while named policy/profile dependencies retain their text identity. The shared-delivery sequence alone is constrained to positive signed-64-bit range, matching the provider persistence columns; the general V1 sequence grammar is unchanged. Malformed values return validation failures rather than conversion exceptions. Planning converts these refusals to `PACK_INPUT_INVALID` before transaction/progress writes.

`deriveProviderPackInputDigests` is the one pure V1 definition used by readiness and durable admission. Admission recomputes desired-state, contents, probability, valuation, and EV-input hashes from the captured bytes before allocating a request, instead of trusting a caller's declared evidence. This does not calculate EV or change canonical snapshot bytes. Tests refuse each forged digest with no head/request writes and prove that the maximum valid shared sequence is acknowledged and replayable.

The combined P01 contract, shared-boundary, readiness, and PostgreSQL matrix passes 50 checks with zero skips; affected contract/database/service lint and typechecks plus the standards ratchet pass. The audit endpoint subsequently responded successfully and a fresh full `npm run verify:framework` is in progress. Task completion and merge approval are still pending that full result and current PR96 CI. The older blocker/evidence records below remain historical, not current approval.

### Current merge blocker — 2026-09-03

The economics-digest correction is committed and pushed in `2ab594fef399495793cba9bb7127b98ef593c8a3` and its review thread has a fix reply. All 33 focused checks, database/service lint and typechecks, docs, and the zero-finding standards ratchet pass on parent `5198bd4ad7b79bf61a383b7bf159cb30dca638be`. No new automated review findings were reported for that correction.

The unchanged `npm run verify:framework` was attempted locally and failed at npm audit. Parent PR96's [current-head CI run](https://github.com/dadriano/packscout/actions/runs/33820664988) independently failed at the same audit step (exit 2) before tests. Supplemental local verification passed the static and Prisma checks, all workspace lint/typechecks, and the ordinary database lane, then the existing exact-5,000-record test exceeded its 30-second transaction limit. An isolated rerun also timed out at about 32 seconds. No timeout, baseline, audit exception, or verifier was weakened. Neither PR96 nor PR95 is merged; no publication processor or production operation was enabled.

Resume by obtaining a green unchanged full gate, including the maximum-volume database test, then merge PR96. Restack only P02-owned commits onto the resulting main, retarget PR95 to main, reverify, and merge only when its current gate is green. Preserve the separately implemented P03 worktree; it must inherit the final parent and pass its own gate before publication.

PR98 also left the existing card source guard asserting superseded metric bindings. PR96 corrects that guard in `ca375cc4960e90ba1e6e316e073be5bffda000ee`, asserting all four gross/net dollar/percent metrics; all 527 frontend tests and frontend lint pass on that parent. This is test-only, with no UI or EV calculation change. P02 inherits it rather than duplicating the correction.

Review follow-up (2026-09-03): PR95 discussion `3929197632` identified that the seal boundary compared declared economics hashes but did not recompute the canonical economics tuple. The new regression first failed with `Missing expected rejection`, despite passing the complete publication-envelope validator. The seal now recomputes the V1 tuple (price, full records, probability/valuation/EV-input digests, chase, and EV) before any writes. All 33 readiness/persistence checks pass, including zero artifact/batch/intent/operation/receipt writes, an unchanged inactive head, and a reusable lease after rejection. Prior full-gate evidence below is historical; current delivery remains pending restacking and current-head verification.

Review corrections (2026-09-03): lifecycle-only admission and seal now share a complete baseline-preservation rule, captured aliases use the public 120-character/unique constraint, and shared boundary keys hash the full external identity before adding their namespace. The focused matrix passes 32 checks, including direct seal refusal of forged lifecycle metadata and replay of a 200-character shared identity. `npm run verify:framework` passed in full on implementation `994ea17cf91e8248c98da6921cd7e6debe0845ea`, with direct parent `90097845ba0b3078e24ff22e7317a2846c9ea452` (PR96). The earlier upstream lint blocker below is resolved on this stack; no check was weakened.

P02 implements provider-local persistence and deterministic readiness only. It adds no scheduler, worker registration, public-store client, deployment command, compatibility adapter, or alternate catalog version. P03 assembles snapshots; P04 produces profile/shared dependencies; P06 binds transaction-local input readers and authenticated public-store transport to these repositories.

Intentional adaptations to `tech-002`, grounded in merged main:

- Separate provider clients, the bounded gateway, and immutable database identity already exist. No PR66 code needs to be ported again.
- Native canonical writes already have a database-enforced transactional `promotion_changes` ledger. The planner consumes that durable ledger and owns a separate publication checkpoint, rather than adding hooks to the superseded ingestion repository. Canonical source progress is protected by the existing ledger transaction; publication progress moves only after every affected pack has a durable request or exact no-op. There is no notification dependency or second EV queue.
- `PackInputCapture` is an explicit transaction-bound composition port. P02 persists its complete allowlisted bytes before assembly, validates scope/source/dependency identities, and never performs lazy reads during sealing. P06 must bind the native and P04 readers through the supplied transaction, without network calls or EV recalculation. The port is deliberately not backed by a provider-wide release adapter.
- Missing prerequisites remain sequenced `waiting`/`blocked` desired-state rows, with no claimable assembly command until complete inputs exist. Invalid input captures retain only a bounded native identity/reason marker, never rejected payloads. Later observations allocate new immutable requests.
- Large impact boundaries persist keyset page progress and hash-chained page receipts. A result with `complete: false` has no acknowledgment digest; callers resume the same boundary. P04 delivers shared shards in increasing provider sequence, retries the same identity after lost responses, and never acknowledges an incomplete result. Each cycle bounds affected packs and total captured input bytes.
- Coalescing includes the publication epoch. A hold/resume can prepare a fresh request and activation intent for identical bytes under a new epoch, without reopening terminal work. Source identities include the immutable change-boundary digest so a later return to earlier content still gets a new activation episode.
- The one per-pack build/activation lease uses a deferred, scoped SQL reference guard for its polymorphic target. Organization/provider authority is bound once against `database_identity`; all downstream records use composite scoped foreign keys. Public head reads remain authoritative; the local head is only a scheduling mirror.
- Polling durable state is sufficient; no wake table or notification processor is added while this phase is dormant.

### Automated evidence

| Acceptance area | Evidence |
|---|---|
| Complete/missing/invalid inputs, EV unavailable/technical/expired/mismatched, lifecycle baseline/freeze, exact no-change, protected fields | `packages/services/src/provider-pack-readiness-evaluator.test.ts` |
| Exact direct/shared membership, non-top valuation dependency, aliases, contents/odds/snapshot ownership, irrelevant pulls/profile-only changes | `packages/services/src/provider-pack-publication.integration.test.ts` |
| Enqueue/checkpoint/seal/batch/intent/receipt/complete crash boundaries; immutable replay; artifact reuse; independent claims and providers; simulated unavailability | Same PostgreSQL integration suite |
| 251-pack paged expansion, poison isolation, scope/source mismatches, stale shared delivery, expired lease, hold/epoch fencing and bounded retries | Same PostgreSQL integration suite |
| Exact role inventory, scoped local references, immutable episode and progress guards | `packages/database/prisma/distributed-schema-contract.test.ts` plus real migrated provider databases |

### Verification result — 2026-09-03

`npm run verify:framework` passed on implementation `a03129f5a8f84d5ccdb9930a840a4908206cdd8e`. The gate found an omitted local runtime grant list; the explicit ten-table list and publication sequence grant were added and the unweakened provisioning tests passed. The final run passed all product/tooling lanes and production builds.

Main then included the independent frontend-only PR94. P02 was rebased onto `0d73ff3970aa2c8e4dec9dd4905caf6380997567`; `git range-diff` proved both implementation patches unchanged. Rebased implementation `0727718d6fde3e0da94382796b11a7d2c81da4de` passed `check:framework`, the standards ratchet, all workspace typechecks, all 521 frontend tests, and production builds again. The focused P02 readiness/crash matrix passed 29 checks, and the focused local provisioning suite passed 12.

Main advanced again with PR93 before publication. P02 was rebased onto `3db9ba77d84ca7a828e513ff59955041bfb94175`; `git range-diff` again proved the implementation patches unchanged (`1dc7fbde8c699cc0523c73c0de190a38e80b285d`). The full framework gate was rerun and passed framework/Prisma/ratchet checks and all non-frontend lint lanes, but failed at the existing PR94 inspector's `react-hooks/set-state-in-effect` error in `apps/frontend/components/catalog/ChaseCollectibleInspector.client.tsx:123`. That file has no P02 changes; [main CI reports the same failure](https://github.com/dadriano/packscout/actions/runs/33808683512). Current full-gate status is failed. All workspace typechecks and the 29-check P02 matrix passed again on this base. Phase delivery remains blocked and the PR must stay draft until the upstream lint failure is fixed and the full gate passes.

After the blocked full gate, all workspace typechecks, the 29-check P02 matrix, the complete tooling lane (1,440 passing checks, nine existing skips, plus three embedded-admin checks), and production builds passed on the current base. No check was disabled or weakened. Draft PR: https://github.com/dadriano/packscout/pull/95.

No browser acceptance surface exists in P02, and no environment was deployed or enabled. The phase-only implementation spans 23 authored files and approximately 1,700 changed lines including tracker metadata, with no generated diff.
