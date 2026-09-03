# Technical Spec: Public Store, Publication, Recovery, and Retention

**ID:** pack-version-publication/tech-003
**Related tasks:** pack-version-publication/005, pack-version-publication/006, pack-version-publication/009
**Depends on technical specs:** pack-version-publication/tech-001
**Spec status:** draft

## Purpose

Store, activate, recover, and retain complete pack/profile snapshots in Convex so each pack advances through one authenticated atomic head and every failed attempt leaves its prior complete state readable.

## Current System Context

### Confirmed repository facts

- `convex/schema.ts` currently models a catalog-wide release, release-scoped pack/content/search records, saved items, and Heat records.
- `convex/publicRepacks.ts` and its helpers read through a singleton release state; no per-pack active-head table or pack publication endpoint exists.
- `convex/convex.config.ts` declares runtime environment and Privy values but no publication keyring, cursor-signing key, or retention authorization configuration.
- The project uses `convex-test` patterns and Vitest fixtures; the Convex guidelines require validators on every function and recommend internal functions for sensitive writes.
- PR 66 contains useful start/batch/finalize, request authentication, receipt reconciliation, lease, and retention-proof mechanics, but its activation authority is wider than one pack.

### Confirmed task constraints

- Finalization proves a complete immutable entity; activation is a separate compare-and-swap operation.
- `ActivePackHead`, `ActiveProviderProfileHead`, and `ActiveCollectibleProfileHead` are the only public reachability roots.
- Public-store operations replay exactly for 30 days, and an ambiguous response is reconciled by status before any resend.
- Hold, retained-snapshot activation, and resume affect one pack and fence older publisher epochs.
- Workers, writer credentials, recovery commands, and pruning remain disabled in production until the launch operation authorizes them.

## Proposed Implementation

### Convex module boundary

Use authenticated HTTP actions only as the network boundary. Each action validates and authenticates a strict request, then calls a small `internalMutation` or `internalQuery`; browser bundles never import publication modules.

| Module | Responsibility |
|---|---|
| `packCatalogHttp.ts` and `http.ts` | Private routes, bounded body parsing, signature verification, and structured responses |
| `packSnapshotStore.ts` | Pack start, batch, finalize, activate, status, block, hold, retained activation, and resume |
| `profileSnapshotStore.ts` | Provider/collectible start, batch, finalize, activate, status, and block |
| `packCatalogOperationStore.ts` | Idempotency, canonical request/receipt digests, replay expiry, and status reconciliation |
| `packCatalogRetention.ts` | Protection roots, dry-run plans, signed cursors, revalidation, deletion, and receipts |

Declare the publication verification keyring, request clock-skew bound, cursor-signing key, and environment in `convex/convex.config.ts`. Keep key material in Convex environment settings and worker secret storage, never in checked-in configuration.

### Authenticated operation protocol

Every request includes environment, organization, provider or catalog scope, entity kind, stable entity ID, snapshot ID, operation ID, idempotency key, canonical body digest, issued time, expiry, and required publication sequence or epoch. The worker signs the canonical request envelope with a named key; Convex verifies the signature and exact operation scope before reading mutation state.

Every accepted, repeated, refused, or conflicted operation stores a bounded receipt with request digest, result digest, current work state, resulting head evidence, and completion time. An exact repeat inside 30 days returns the stored receipt; a reused identity with changed bytes is refused; an expired identity returns `operation_expired` with reason `OPERATION_EXPIRED`.

### Pack staging and activation

1. `startPublicPackSnapshot` creates or verifies one immutable staging record from the descriptor and ordered batch manifest.
2. `applyPublicPackSnapshotBatch` validates ordinal, count, canonical bytes, entity identity, and batch hash before storing the whole bounded batch document and its ID; when no pack head exists, it also proves active collectible-profile heads for that bounded content batch.
3. `finalizePublicPackSnapshot` verifies all expected batch receipts, aggregate hash, counts, summary/detail evidence, complete initial-profile proof, membership-search digest, and protected-field scan before marking the snapshot complete.
4. `activatePublicPackSnapshot` compare-and-swaps the one pack head using expected generation, snapshot, publication epoch, hold state, and next provider-local sequence.
5. The mutation stores the new active snapshot, immediate previous snapshot, indexable summary, accepted sequence, generation, and activation time atomically; no reader can observe staging data.

The descriptor carries bounded exact membership-search text and its digest, derived from all stable collectible IDs. Activation copies that verified text into the one pack head, so desired-collectible search indexes only current heads and one pack activation writes no shared index record.

If the requested snapshot is already active under a lower accepted sequence, activation updates only sequence/generation evidence and returns `already_active`; snapshot bytes and identity do not change. A stale or lower sequence never advances the head.

On a pack's first publication, start verifies its active provider-profile head and each bounded batch verifies its referenced collectible-profile heads. Because active profile heads are protected roots and have no delete operation, finalization can seal the aggregate prerequisite proof and activation can verify that proof without reading an unbounded dependency set. Later pack activations require the stable profile identities to remain resolvable but do not bind to a newer profile generation.

### Profile staging and activation

Provider and collectible profiles use the same staged-operation protocol with separate validators and heads. One profile activation compare-and-swaps only that stable profile identity. A later profile change cannot alter sealed pack-local display, valuation, chase, or EV bytes.

Profile records remain bounded by P01 constants. Provider scope signs provider-profile operations; catalog scope signs collectible-profile operations. The first pack depending on a profile remains absent until the required head exists.

### Authorized initial population

`seed-pack-catalog` is available only before the first successful launch ledger, while recurring claims are disabled. It requires an active admin with `pack_catalog:launch`, a trusted deployment identity, exact environment, cutoff, launch-plan digest, idempotency key, and the complete included/excluded inventory.

The first accepted receipt durably fixes that entire request before creating work. Exact retries use the same planner, assembler, profile-first ordering, and publisher as recurring work; any changed digest, cutoff, inventory, scope, or post-launch attempt is refused. No browser, public API, or Admin route can invoke it.

### Publisher and shared-delivery workers

Implement `ProviderPackPublisher` as a state machine over P02 records rather than one long transaction:

1. Claim one ready build request under the current worker-gate generation and a pack-scoped lease.
2. Assemble, seal/reuse, and enqueue its distinct activation intent in the provider database.
3. Persist the next exact public operation and request digest before network I/O.
4. Send, validate the receipt, and persist it before advancing the local intent.
5. Repeat through start, batches, finalize, and activate; verify gate generation and lease fence before every local completion.

`CentralProfilePublisher` follows the same operation protocol over one profile intent, without a pack lease. `SharedPackFanoutWorker` only hands a delivery to the addressed provider planner and acknowledges its exact result digest.

Use fair bounded polling by provider and entity. Retry transient transport/service failures with capped exponential backoff and jitter. Block permanent schema, protected-field, domain, or authorization failures for only that entity. Continue processing independent packs after each bounded attempt.

### Ambiguous result reconciliation

After timeout, connection loss, process interruption, or an unreadable response, do not create a new operation. Persist `RECEIPT_AMBIGUOUS`, call the matching status operation with the same identity and request digest, and handle one of four results:

- Exact receipt found: persist and continue from it.
- Operation absent: resend the exact persisted bytes and identity.
- Operation present with different digest: block/refuse without mutation.
- Status unavailable: schedule another bounded reconciliation attempt.

### Per-pack recovery

Protected commands run from local release scripts or worker command entry points, never an Admin or public route. A preview reads provider and Convex evidence and returns a digest; apply requires that exact unexpired digest, scope, expected state, actor, permission, and trusted execution identity.

`rollback-pack-snapshot` first calls `holdPublicPackHead`, which increments publication epoch and fences prior-epoch activations. It then repairs the provider mirror and calls `activateRetainedPublicPackSnapshot` for only the immediate previous complete snapshot under the exact held generation. The head remains held after rollback.

`resume-pack-publication` reconciles the public head as authority, repairs the provider mirror, coalesces accumulated desired work, prepares only the greatest complete sequence for the current epoch, and releases the exact held generation/epoch. Normal publication resumes after the mirror records the release receipt.

`retry-pack-publication` accepts only matching waiting transient work or due `retry_scheduled` work. Source correction creates a new sequence; it does not reopen permanent blocked or terminal intent records.

### Worker gate

Store one environment-scoped `PackCatalogWorkerGateV1` with generation and `disabled`, `draining`, or `enabled` state in the central database. Every recurring planner, fan-out, assembler, profile publisher, and pack publisher checks the generation before claim and before progress commit.

`draining` rejects new claims while leases finish or expire. `disabled` requires no live claims. The separately authorized seed command may operate against its fixed inventory while recurring work is disabled; no other bypass exists.

### Retention and bounded deletion

Treat each snapshot as an immutable deletion group containing its root document and bounded batch document IDs. Store those child IDs on the finalized root so an apply mutation can revalidate roots and delete a complete group atomically without reading large bodies.

Protect active, immediate-previous, held/rollback, staging, publishing, retry, active-lease, unresolved recovery, and replay-window roots. A formerly active snapshot ages from deactivation; a never-active completed snapshot ages from terminal completion. Both minimums are 30 days.

A blocked request is terminal for retention only after its stable reason and any referenced complete recovery snapshot are durable. Missing, contradictory, unreadable, or concurrently changing evidence is `ambiguous` and remains protected.

`PackProfileSnapshotRetentionPlanV1` is generated from a fresh bounded root scan and classifies each group as `protected`, `eligible_after`, or `ambiguous`. Production apply requires the exact unexpired plan digest and successful-launch pruning authorization, revalidates each group immediately before deletion, and commits one deletion receipt with each atomic group deletion.

The signed prune cursor binds environment, policy/plan/authorization digests, ordered candidate-manifest digest, last receipted key, cumulative groups/bytes, issue time, and expiry. Same-plan receipts are resumable progress; a missing group without its exact receipt is an error.

Provider/central authoritative history, saved items, authentication/user data, and unrelated operational records are outside public snapshot pruning. Safe failure retains extra unreachable data.

## Code Changes

### Convex

1. Replace the catalog-wide public schema with pack/profile snapshot, head, operation, and retention tables defined below.
2. Add private HTTP routing, request-authentication helpers, strict Convex validators, internal store functions, and bounded sanitized receipt serialization.
3. Add pack/profile staging, finalization, activation, hold, retained activation, resume, status, and block implementations.
4. Add retention root collection, policy/plan digesting, dry run, cursor verification, group revalidation, atomic deletion, and receipt functions.
5. Generate Convex types and keep publication/internal modules absent from browser-safe package exports.

### PostgreSQL services and workers

1. Add `convex-public-pack-publication-client.ts` and `convex-public-profile-publication-client.ts` in `packages/services/src` with exact request persistence hooks.
2. Add pack/profile publisher services, shared-delivery worker, recovery preview/apply services, and gate-aware claim wrappers.
3. Add disabled worker compositions and entry points under `apps/worker/src`; declare explicit environment and concurrency bounds in runtime config.
4. Add recovery, seed, and worker-gate command entry points under `scripts/local`, `scripts/preproduction`, and `scripts/live` with environment-specific package scripts.
5. Extract only request/receipt security, operation reconciliation, and retention-proof primitives from the pinned PR 66 files listed in tech-001.

## Database / Schema Changes

### Convex pack and profile data

| Table | Required indexes/search indexes |
|---|---|
| `publicPackSnapshots` | `by_snapshot_id`, `by_pack_and_content_hash`, `by_state_and_terminal_time` |
| `publicPackSnapshotBatches` | `by_snapshot_and_ordinal`; one document per bounded batch |
| `activePackHeads` | `by_public_repack_id`, provider/lifecycle/availability and supported sort-key indexes; search indexes for pack text and exact membership tokens |
| `publicProfileSnapshots` / `publicProfileSnapshotBatches` | kind/entity/content-hash, state/time, and snapshot/ordinal indexes |

Use separate `activeProviderProfileHeads` and `activeCollectibleProfileHeads` tables, each unique by its stable public identity and indexed for bounded lookup/search. The task 005 read layout is completed in tech-004.

### Convex operations and retention

| Table | Purpose |
|---|---|
| `packCatalogOperations` | Immutable entity/operation/request identity and 30-day replay expiry |
| `packCatalogReceipts` | Canonical bounded result evidence keyed by operation ID |
| `packCatalogRetentionPlans` | Immutable dry-run policy, roots, candidate manifest, expiry, and digest |
| `packCatalogDeletionReceipts` | Same-plan atomic group deletion evidence and byte/count totals |
| `packCatalogLaunchAuthorizations` | Exact successful-ledger digest and bounded pruning authority |

All documents use explicit Convex validators. Queries use indexes plus `.take(limit + 1)` or native pagination; no path calls unbounded `.collect()`.

### Central/provider additions

Add `pack_catalog_worker_gates` and immutable gate receipts centrally. Extend the P02 provider operation/receipt rows with Convex request/receipt digest, expiry, attempt, reconciliation status, and sanitized remote head evidence. Add central profile equivalents without combining different entity identities.

## Interfaces, APIs, and Endpoints

### Private pack HTTP operations

| Method/path | Operation |
|---|---|
| `POST /internal/pack-catalog-v1/pack/start` | `startPublicPackSnapshot` |
| `POST /internal/pack-catalog-v1/pack/batch` | `applyPublicPackSnapshotBatch` |
| `POST /internal/pack-catalog-v1/pack/finalize` | `finalizePublicPackSnapshot` |
| `POST /internal/pack-catalog-v1/pack/activate` | `activatePublicPackSnapshot` |
| `POST /internal/pack-catalog-v1/pack/status` | `getPublicPackPublicationStatus` |

The remaining pack routes are `/block`, `/hold`, `/activate-retained`, and `/resume`, mapped exactly to `blockPublicPackSnapshot`, `holdPublicPackHead`, `activateRetainedPublicPackSnapshot`, and `resumePublicPackHead`.

### Private profile HTTP operations

| Method/path | Operation |
|---|---|
| `POST /internal/pack-catalog-v1/profile/start` | `startPublicProfileSnapshot` |
| `POST /internal/pack-catalog-v1/profile/batch` | `applyPublicProfileSnapshotBatch` |
| `POST /internal/pack-catalog-v1/profile/finalize` | `finalizePublicProfileSnapshot` |
| `POST /internal/pack-catalog-v1/profile/activate` | `activatePublicProfileSnapshot` |
| `POST /internal/pack-catalog-v1/profile/status` | `getPublicProfilePublicationStatus` |

`POST /internal/pack-catalog-v1/profile/block` maps to `blockPublicProfileSnapshot`. All private routes return an operation outcome, resulting work state, receipt identity/digest, and bounded head/status evidence.

### Publisher and recovery interfaces

`ProviderPackPublisher.publishClaimedBuild`, `CentralProfilePublisher.publishClaimedProfile`, and `SharedPackFanoutWorker.processClaimedDelivery` consume the repositories defined in tech-002 and clients defined here.

`ConvexPublicPackPublicationClient` mirrors every private pack operation, and `ConvexPublicProfilePublicationClient` mirrors every private profile operation. Both accept only P01 request types, enforce deadlines/cancellation, and return validated P01 receipts rather than raw HTTP responses.

Protected commands are `seed-pack-catalog`, `retry-pack-publication`, `rollback-pack-snapshot`, and `resume-pack-publication`. Each has separate `preview` and `apply` modes except seed, whose first accepted receipt fixes its complete inventory and launch-plan digest.

`PackCatalogWorkerControl.setGate({ expectedGeneration, targetState, environment, configurationDigest, cutoff?, idempotencyKey })` returns the resulting `PackCatalogWorkerGateV1` plus per-worker-family receipts. It is callable only by environment-specific release commands.

The retention interfaces are `PackProfileSnapshotRetentionPolicyV1`, `PackProfileSnapshotRetentionPlanV1`, and `PackProfilePruneCursorV1`; apply additionally requires `pruningAuthorizationId`, launch-ledger digest, policy digest, expiry, group cap, and byte cap.

## Data Flow

### Normal pack publication

1. A gate-aware worker claims one ready P02 pack request and assembles/seals its complete artifact.
2. It persists a start operation, sends it to Convex, verifies/persists the receipt, and repeats each bounded batch.
3. Finalize proves every batch and marks the snapshot complete without changing a head.
4. Activate compare-and-swaps only that pack's head; readers see either the prior or new complete snapshot.
5. The worker persists the receipt, completes the local intent, and repairs its head mirror from Convex evidence.

### Unknown response

1. The worker records `RECEIPT_AMBIGUOUS` against the already persisted operation.
2. Status asks Convex for that same operation ID and request digest.
3. An exact receipt continues; absence resends the same bytes; mismatch blocks; unavailable status retries.
4. Lease and gate fences are checked before any local state advancement.

### Held rollback and resume

1. Authorized rollback holds the named public head and increments its epoch.
2. The provider mirror reconciles to that authoritative held state.
3. Convex selects only the immediate previous complete snapshot while the head remains held.
4. Desired changes continue coalescing locally without activation.
5. Resume prepares the greatest complete sequence, releases the exact epoch/generation, and repairs the mirror before normal claims continue.

### Retention apply

1. Evaluate current heads, holds, operations, leases, recovery roots, and 30-day clocks into a signed dry-run plan.
2. Require exact unexpired launch authorization, policy digest, plan digest, cursor, and cumulative caps.
3. Revalidate the next candidate's roots and immutable child-ID manifest.
4. Delete the complete bounded group and insert its receipt in one mutation.
5. Return the signed next cursor or terminal totals; interruption resumes after the last receipted group.

## Error Handling and Edge Cases

- Incomplete, reordered, changed, oversized, or cross-entity batches remain unreachable and return `refused` with a stable content/domain reason.
- Stale generation, sequence, epoch, hold, gate, lease, scope, or request digest returns `conflict` or `refused` without changing any head.
- A missing initial profile head returns `PROFILE_HEAD_MISSING` for only the first dependent pack activation; the completed pack artifact remains retryable.
- An unreachable public service or ambiguous receipt preserves the operation and schedules reconciliation; it never manufactures a new identity.
- Missing, contradictory, changing, or unreadable retention roots classify the group `ambiguous`; safe failure retains extra data.

## Testing and Verification

1. Use `convex-test` with the generated module map to test every operation validator, exact replay, changed-body replay, expiry, staging/finalize rule, and authorization scope.
2. Race same-pack activations, unrelated-pack activations, profile activations, holds, rollback, resume, gate changes, and lease loss; assert only scoped heads change.
3. Inject failure before send, after remote commit, before local receipt, after local receipt, and after head activation; assert status reconciliation converges once.
4. Run public-read fixtures while all writers are paused, one provider is unavailable, one pack is held, and another pack continues publishing.
5. Exercise threshold retention, root changes, interrupted cursor resume, exact replay receipts, cumulative caps, and full-group atomic deletion; then run `npm run verify:framework`.

The named scenarios are **Atomic store and six-journey catalog contract**, **Publication ambiguity and epoch-fenced recovery matrix**, and **Thirty-day snapshot retention and bounded prune**.

## Open Questions and Risks

- P01's measured batch/document limits must make one Convex batch mutation and one complete-group deletion fit transaction limits. If not, lower the per-pack content cap or batch size before P05; do not weaken complete-group semantics.
- Exact membership-token search on one active head per pack must be verified against Convex tokenization and search-field limits using the maximum-content fixture. If it is unsupported, add one pack-scoped active-index document updated in the same head transaction; do not introduce shared provider manifests.
- Key rotation needs two simultaneously accepted verification keys for a bounded overlap, but each request still names one key and one expiry. Rotation changes security configuration, not the catalog contract or read path.
- Public head state is authoritative after any split commit between Convex and PostgreSQL. Provider scheduling stays conservative until status reconciliation repairs the mirror.

## Handoff Notes

P05 owns the Convex schema and authenticated store but leaves routes unreferenced by buyer pages and production writer secrets absent. It can proceed beside tech-002. The P06 and P09 portions of this spec require tech-002 to be complete; P06 connects disabled publishers and protected commands, and P09 adds dry run and deletion without enabling production pruning.

Review the activation mutation as the critical section: it must touch one pack head, verify a completed immutable snapshot, and compare every generation/epoch/sequence precondition in one Convex transaction.
