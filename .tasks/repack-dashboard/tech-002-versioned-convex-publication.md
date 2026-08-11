# Technical Spec: Versioned Convex Publication

**ID:** repack-dashboard/tech-002
**Related tasks:** repack-dashboard/002, repack-dashboard/003, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/010, repack-dashboard/012
**Depends on technical specs:** repack-dashboard/tech-001
**Spec status:** draft

## Start Here

Generate the root Convex scaffold and `_generated` output; the first result must be an existing `convex/_generated/ai/guidelines.md` ready to read before any schema, function, or HTTP-action implementation begins.

## Purpose

Publish each PostgreSQL `CatalogSnapshotV1` as an authenticated, immutable Convex snapshot that becomes public only after complete reconciliation and atomic activation.

## Current System Context

### Confirmed repository facts

- Current `main` has no `convex/` directory, Convex dependency, generated API, deployment configuration, or publication secret contract.
- `convex/_generated/ai/guidelines.md` is absent. This spec uses official Convex documentation only as a planning fallback; generated project guidance is an implementation prerequisite.
- Data-pipeline PR #1 at `0dc6bcc` adds PostgreSQL canonical history and worker composition but no public export list query, Convex publisher, or public configuration source.
- `tech-001` supplies the approved PostgreSQL configuration, monotonic publication ledger, and complete `CatalogSnapshotV1` consumed here.
- UX specs `ux-001`, `ux-002`, `ux-003`, and `ux-005` require completed-snapshot freshness, coherent Overview data, approved actions only, and distinct delayed versus missing-initial-snapshot states.

### Official Convex constraints

- [HTTP actions](https://docs.convex.dev/functions/http-actions) live behind exact routes in `convex/http.ts`, receive Fetch `Request`/`Response` objects, call database functions through `ctx.runMutation`, and have a 20 MB request/response limit.
- HTTP actions are not automatically retried; the controlled PostgreSQL publisher owns retry and idempotency behavior.
- [Internal functions](https://docs.convex.dev/functions/internal-functions) cannot be called directly by clients and are the required write surface behind the publication HTTP actions.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/) must constrain reads with index ranges; post-query filters do not reduce scanned rows.
- `convex-test` supplies fast function/HTTP tests, but its mock does not enforce backend limits; size and scale gates also run against a real non-production backend.

## Proposed Implementation

### Convex project boundary

1. Keep Convex functions and schema in root `convex/`; browser components import generated client references, never publication functions or server helpers.
2. Add the Convex runtime/client dependency and explicit root scripts for code generation, development, deployment, and tests.
3. Separate public read queries from publication HTTP actions and `internalMutation` functions.
4. Store no V1 user records in Convex; theme remains device-local and anonymous telemetry is a separate task `012` boundary.
5. Use separate Convex deployments and publication keys for local, preproduction, and live environments.

### Immutable snapshot lifecycle

1. `start` creates or resumes one `staging` snapshot using the PostgreSQL publication ID, source sequence, manifest hash, and expected counts.
2. `batch` validates and inserts deterministic bounded pack/shard batches without modifying the active snapshot.
3. `finalize` reconciles all batch hashes/counts, marks the candidate complete, and switches the singleton active pointer in one mutation transaction.
4. `refresh` records a newer successful canonical observation for unchanged content, updates only singleton freshness metadata, and schedules a stale guard bound to that observation sequence.
5. Failure leaves the safe active pointer unchanged; confirmed rollback targets a reconciled complete snapshot or explicitly clears the pointer, while bounded retention removes unreadable inactive data.

### Machine-to-machine authentication

- Sign every request with HMAC-SHA256 over method, path, timestamp, idempotency key, and SHA-256 body digest.
- Send key ID/signature in `Authorization`, plus `X-PackScout-Timestamp`, `X-Idempotency-Key`, and `Content-Digest` headers.
- Keep scoped signing keys only in worker and Convex environment secrets; permit two key IDs during rotation and expose neither to Next.js nor public queries.
- Reject timestamps outside five minutes, unknown key IDs, invalid digests/signatures, missing headers, and request bodies above 512 KiB before calling a mutation.
- Register no browser CORS route for publication; this is a server-to-server `.convex.site` boundary.

The same signature, replay, digest, body, and idempotency rules apply to every publication/recovery route, including phased `sync-blocks`. `status` is read-only but remains a signed POST action so PostgreSQL can reconcile a Convex success whose local acknowledgement was lost.

Key IDs are operation-scoped: worker publication keys cannot call `rollback` or `unblock`, and a separate recovery key is available only to the protected admin service and Convex environment. Both scopes support two key IDs during rotation. A valid HMAC under the wrong operation scope returns `PUBLICATION_UNAUTHORIZED` before mutation.

### Public-query readiness

- Every public query reads `catalogState.activeSnapshotId` once and accesses only that complete snapshot.
- `getDashboardBundle` will read compact catalog-query shards and selected detail in one Convex query so KPIs, opportunities, summaries, freshness, and selection share one database state.
- `listPublicPacks` will read the same compact shards, apply the versioned deterministic relevance or metric order, then load only the visible public-pack details.
- Query-shard rows carry direction-specific sort keys so unavailable values sort last and `publicPackId` is the final tie break in both directions.
- Cursor pagination remains bounded to 25 by default and 50 maximum; multi-select/range post-filter cost is a 1,500/10,000-record launch gate, not an unbounded fallback scan.

## Code Changes

### Convex paths

| Path | Change |
|---|---|
| `convex/schema.ts` | Define snapshot/read tables plus publication batches, exact operation receipts, and durable manifest blocks with bounded indexes. |
| `convex/http.ts` | Register exact signed publication/recovery routes, including bounded authoritative block-set synchronization. |
| `convex/catalogPublication.ts` | Implement HMAC/body validation and stable HTTP response mapping. |
| `convex/catalogPublicationInternal.ts` | Implement publication lifecycle, exact receipts, rollback/unblock, block-set sync, and bounded retention operations. |
| `convex/lib/publicationAuth.ts` | Canonicalize the signed request, verify HMAC/timestamp/digest, and parse active key rotation config. |

### Publisher and workspace paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/services/src/convex-catalog-publisher.ts` | Add signed HTTP client, deterministic batching, retry policy, idempotency keys, and stable failure mapping. |
| `apps/worker/src/provider-worker-composition.ts` | Invoke publication only from a committed ledger row after canonical export succeeds. |
| `packages/contracts/src/catalog-snapshot-v1.ts` | Reuse the shared runtime schema; do not create a second publication DTO. |
| Root and frontend `package.json` files | Add Convex/codegen/test scripts and only the dependencies required by generated guidance. |
| `convex/*.test.ts` and publisher tests | Cover HTTP auth, internal transitions, limits, retries, activation, rollback, and data leakage. |

The publisher must not be imported by `apps/frontend`. The frontend may import only generated public query references and JSON-safe public result types.

### Protected rollback-operation paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/contracts/src/catalog-publication-operations.ts` | Define exact-receipt status, rollback target/clear, unblock, typed confirmation, stable outcome, and audit contracts. |
| `packages/database/src/catalog-publication-ledger-repository.ts` | Transition ledger state with optimistic expected state and persist Convex receipts. |
| `packages/services/src/catalog-publication-operations-service.ts` | Authorize status/rollback/unblock, require exact confirmation, sign Convex actions, and reconcile the ledger. |
| `apps/admin/server/routes/catalog-publications.ts` | Add CSRF-protected status/rollback/unblock routes with separate rollback and unblock permissions. |
| `apps/admin/src/pages/CatalogPublicationsPage.tsx` | Show safe candidates/blocks and require exact typed confirmation; no generic destructive control. |

## Database / Schema Changes

### Convex tables

| Table | Required fields and responsibility |
|---|---|
| `catalogState` | Singleton active/previous IDs, observation/freshness fields, authoritative block sequence/count/set hash, block-sync state, and updated time. This is the sole active authority. |
| `catalogSnapshots` | Schema/publication/source identity, canonical manifest fingerprint, content/config/origin-set hashes, bounded immutable approved platform-config array, config/pack/shard/batch counts, facets, lifecycle state, and timestamps. |
| `publicPacks` | Snapshot/public IDs, sanitized summary/detail, materialized metrics, approved actions/media, search text, sort keys, and source fingerprint. |
| `catalogQueryShards` | Snapshot/shard number and bounded compact rows for coherent filters, relevance tiers, metric sorts, facets, KPIs, opportunities, summaries, and selection eligibility. |
| `publicationBatches` | Snapshot, operation/batch index, idempotency key, body hash, record count, byte count, and accepted time. |

Snapshot lifecycle is `staging | complete | failed | retired | blocked`; active status is represented only by `catalogState.activeSnapshotId`. A safe completed previous snapshot remains complete and is merely a rollback candidate. `blocked` data is never readable or eligible as previous/rollback state.

`publicationOperations` stores signed operation kind, stable idempotency/body hash, expected/target publication IDs, sanitized reason, opaque confirmation-receipt hash, result/Convex version, and timestamps. Authenticated actor/audit detail stays in PostgreSQL. Public reads never access `publicationBatches` or `publicationOperations`.

### Operation and safety tables

| Table | Required fields and responsibility |
|---|---|
| `publicationOperations` | Operation ID/kind/idempotency key/body hash, publication ID, observation sequence, result/status, Convex snapshot version, confirmation receipt hash, and timestamps for exact control/terminal receipts. |
| `blockedCatalogManifests` | Rebuildable mirror of PostgreSQL canonical manifest fingerprint/block sequence, originating operation, sanitized reason, blocked/released times, and one-use release receipt. |

PostgreSQL `catalog_manifest_blocks` is authoritative; this table is a derived safety mirror. An active fingerprint is retained even after snapshot documents are deleted. `startPublication` and `finalizePublication` reject it regardless of publication ID and also reject when the mirrored block sequence/count/set hash is not reconciled. A corrected fingerprint may proceed while the old block remains; only separately confirmed `unblock` releases the same fingerprint. Confirmed clear preserves the block. Released mirror/operation receipts remain 30 days.

### Public pack representation

- `publicPackId` is a versioned UUIDv5 over the public-ID namespace, platform key, and canonical pack identity; raw canonical/PostgreSQL IDs are not stored.
- All public comparison money is integer USD minor units. A non-USD-comparable source value remains null with a constrained reason code.
- Materialize `evDollarsMinor = grossEvMinor - priceMinor` and signed EV basis points from pipeline gross-return percentage minus 100 percentage points.
- Select top chase from eligible related canonical assets by highest USD-comparable representative value, then stable public chase ID. If none is comparable, choose the lowest stable public chase ID; use `CHASE_UNAVAILABLE` when that named candidate lacks a representative value and `CURRENCY_UNSUPPORTED` when it has numeric but non-USD/unapproved currency evidence.
- Store only approved HTTPS media/listing URLs, display configuration, promo, and referral parameters copied from the exact PostgreSQL config revision in the manifest.

There is no standalone mutable `publicCatalogConfig` table. Each snapshot manifest contains at most 64 canonically ordered platform-config entries and at most 64 KiB of canonical serialized configuration, plus its count/hash; relevant display/action fields are copied into `publicPacks`. Publication equality, reconciliation, retention, and CSP origin-set deployment checks include the configuration count, config hash, and exact origin-set hash.

Preproduction/live Convex configuration requires `PACKSCOUT_PUBLIC_ORIGIN_SET_HASH`, derived from the same sorted exact image origins as the frontend build. `startPublication` rejects a manifest whose `originSetHash` differs before staging any row; changing the approved origin set therefore requires the coordinated CSP/Convex expected-hash deployment described in `tech-004` before publication.

### Public-value validation matrix

| Field | Convex validation |
|---|---|
| Price | Preserve optional original display money; accept USD comparison only as integer minor units; allow `PRICE_UNAVAILABLE` or `CURRENCY_UNSUPPORTED`. |
| Gross EV | Accept authoritative integer USD minor units; allow `CURRENCY_UNSUPPORTED` or `ESTIMATE_INPUT_INCOMPLETE`. |
| Signed EV $ | Require exact checked `gross - price`; enforce reason precedence `PRICE_UNAVAILABLE` > `CURRENCY_UNSUPPORTED` > `ESTIMATE_INPUT_INCOMPLETE`. |
| Signed EV % | Require exporter-materialized integer basis points equal to validated pipeline gross-return basis points minus `10_000`; never recompute in Convex. |

| Field | Convex validation |
|---|---|
| Buyback | Require integer basis points and `sourceKind` of `direct` or `derived`, or `BUYBACK_UNAVAILABLE`. |
| Top chase | No relation is null plus `CHASE_UNAVAILABLE`; named with no representative value is `CHASE_UNAVAILABLE`; named with numeric non-USD/unapproved evidence is `CURRENCY_UNSUPPORTED`; supported USD is available. |

### Public reason codes

| Public code | Source mapping |
|---|---|
| `ESTIMATE_INPUT_INCOMPLETE` | PackScout estimate inputs are missing or incomplete. |
| `PRICE_UNAVAILABLE` | Canonical USD comparison price is absent. |
| `CURRENCY_UNSUPPORTED` | A value lacks approved canonical USD comparison evidence. |
| `BUYBACK_UNAVAILABLE` | Provider-supported buyback coverage cannot be calculated or supplied. |
| `CHASE_UNAVAILABLE` | No related chase exists, or the selected named chase has no representative numeric value. |

Category absence maps to `Uncategorized`, pack-image absence uses the neutral public fallback, chase-image absence remains text-only, and absent/unapproved Promo or Pack Link fields are omitted. Those states never reuse a metric reason code. Snapshot delay stays in `catalogState` rather than becoming a per-pack reason.

No raw calculator reason, tenant/provider diagnostic, actor, run ID, revision UUID, wallet, username, credential, quarantine record, or provider `data` object is stored in these tables.

### Index and query-shard shape

1. Add unique-guard indexes `catalogState.by_key`, `catalogSnapshots.by_publication_id`, and `publicPacks.by_snapshot_public_pack`.
2. Add `catalogQueryShards.by_snapshot_shard` and `publicationBatches.by_snapshot_batch`; no query may `collect()` the full detailed pack table.
3. Put only compact public ID, normalized search fields, facets, availability, comparison values, null ranks, and direction keys in each query-shard row.
4. Split shards at 96 rows or 48 KiB of canonical serialized row content, whichever comes first, and record shard hashes/counts in the manifest.
5. Version the deterministic search normalizer/ranker in snapshot metadata; public queries do not depend on opaque native-search scoring or its scan cap.

Add unique-guard lookups `publicationOperations.by_operation_kind_idempotency`, `publicationOperations.by_publication_kind`, and `blockedCatalogManifests.by_fingerprint_active`. Mutations query these indexes before insert/transition and reject a second conflicting document; public queries never use them.

### Retention policy

- Keep active and previous snapshots unconditionally.
- Keep at most three additional completed snapshots for seven days.
- Delete abandoned staging and failed snapshots after 24 hours; blocked snapshots become immediately unreadable and their owned documents enter bounded deletion immediately.
- Delete at most 100 documents per retention mutation and reschedule until complete.
- Never cascade from an inactive snapshot until its pack, shard, and batch counts reconcile to zero.

After blocked snapshot-owned data reaches zero, retain its active `blockedCatalogManifests` fingerprint unconditionally until confirmed release; retain released block and sanitized `publicationOperations` receipts for 30 days. A blocked outgoing snapshot is cleared from `previousSnapshotId`; unsafe data is never swapped into that slot.

## Interfaces, APIs, and Endpoints

### Publication HTTP actions

| Method and path | Body and success outcome |
|---|---|
| `POST /internal/catalog-publications/start` | Manifest metadata, bounded config array/count/hash, facets, expected batch/pack/shard counts; returns `created`, `resumed`, or `unchanged`. |
| `POST /internal/catalog-publications/batch` | Publication ID, batch index/kind, deterministic records, batch hash; returns accepted counts or the prior identical result. |
| `POST /internal/catalog-publications/finalize` | Publication ID, ordered batch-hash root, final counts/content hash; returns the atomically active snapshot version. |
| `POST /internal/catalog-publications/refresh` | Active publication ID, newer observation sequence/watermark, observed/data-as-of times, delayed-source count, and stale deadline; returns refreshed singleton metadata without changing snapshot content/pointers. |

### Recovery and reconciliation HTTP actions

| Method and path | Body and success outcome |
|---|---|
| `POST /internal/catalog-publications/status` | Operation ID, exact terminal kind, and terminal idempotency key; returns the exact bound receipt for PostgreSQL reconciliation. |
| `POST /internal/catalog-publications/abort` | Operation ID, optional staging publication ID, expected active ID, and stable sanitized failure category; marks any staging candidate failed and active freshness delayed without changing pointers. |
| `POST /internal/catalog-publications/rollback` | Expected active ID, safe target/clear, PostgreSQL block sequence/set hash, reason, confirmation receipt, and operation ID; returns exact rollback/clear receipt. |
| `POST /internal/catalog-publications/unblock` | Fingerprint, PostgreSQL release-pending sequence/set hash, reason, confirmation/release receipt, and operation ID; returns exact release receipt. |
| `POST /internal/catalog-publications/sync-blocks` | Phased start/batch/finalize protocol for PostgreSQL active block sequence/count/set hash and at most 250 canonical fingerprints per batch. |

Every request uses a stable key shaped as `{operationId}:{operation}:{batchIndex-or-manifest}`. A repeated key with the same body hash returns the recorded result; the same key with a different body returns `IDEMPOTENCY_CONFLICT`.

`status` requires `operationId`, exact terminal kind (`finalize`, `refresh`, `abort`, `rollback`, `unblock`, or `sync-blocks`), and the terminal idempotency key. Its response includes the recorded request body hash, publication ID, observation/block sequence, Convex snapshot version, status/result, and accepted time. PostgreSQL acknowledges a terminal transition only after every expected field matches; absence or mismatch remains a reconciliation failure and does not replay content blindly.

### Stable response envelope

```ts
type PublicationResponse<T> =
  | { readonly ok: true; readonly status: string; readonly result: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code:
        | "PUBLICATION_UNAUTHORIZED"
        | "INVALID_PUBLICATION"
        | "IDEMPOTENCY_CONFLICT"
        | "SOURCE_REGRESSION"
        | "PUBLICATION_STATE_CONFLICT"
        | "RECONCILIATION_FAILED"
        | "CONFIRMATION_REQUIRED"
        | "UNSAFE_ROLLBACK_TARGET"
        | "BLOCKED_MANIFEST"
        | "BLOCK_SET_MISMATCH";
    };
```

Use 400 for malformed input, 401 for authentication/replay-window failures, 409 for idempotency/source/state conflicts, and 422 for manifest reconciliation failure. Retry only network errors, 429, and 5xx responses with the same idempotency key/body.

### Internal-only operations

| Function | Rule |
|---|---|
| `startPublication` | Require reconciled expected block sequence/count/set hash; reject source regression or active blocked fingerprint; return unchanged only for matching content/config/origin hashes. |
| `writePublicationBatch` | Insert at most 250 records and 512 KiB; reject duplicate public IDs or conflicting batch hashes. |
| `finalizePublication` | Recheck expected block set/fingerprint plus ordered batch hashes/counts, then switch active/previous pointers atomically. |
| `refreshObservation` | Require a newer observation sequence for the expected active ID; update only freshness fields and record an idempotent operation receipt. |
| `abortPublication` | Never changes the active pointer; exposes only delayed state publicly. |

`syncBlockedManifests` is a phased internal protocol. Start makes new publication activation unavailable while preserving existing public reads; bounded batches stage the canonical PostgreSQL fingerprints; finalize verifies ordered hashes/count, atomically replaces the mirror, records the authoritative block sequence/set hash, and marks sync ready. An empty replacement deployment must complete this protocol before accepting `start`.

`rollbackPublication` verifies the expected active pointer, PostgreSQL pending block sequence/set hash, and confirmation receipt; validates that a target is `complete`, reconciled, retained, and not blocked; adds the outgoing fingerprint mirror; and changes pointers/operation receipt atomically. Only an explicitly confirmed clear request may clear active/previous pointers. PostgreSQL reserves the block before this call and marks it active only after the exact receipt; an invalid target performs no write while the pending authoritative block still prevents republication.

The protected admin service accepts the exact typed phrase `ROLL BACK <active-publication-id>` for a safe target or `CLEAR <active-publication-id>` when no safe target exists. It records the authenticated actor and phrase hash in PostgreSQL audit, creates an opaque one-use confirmation receipt, supplies `confirmed: true`, and binds the operation to the expected active ID, stable reason, and idempotency key. Convex receives no actor identity, and a malformed direct machine request cannot mint its own successful receipt.

Releasing the same unsafe fingerprint is a separate operation requiring permission `catalog_publications:unblock` and exact typed phrase `UNBLOCK <manifest-fingerprint>`; rollback/clear uses `catalog_publications:rollback` and cannot release it. PostgreSQL first records `release_pending`; Convex removes the mirror only for that expected sequence/set hash and exact receipt; PostgreSQL then marks `released`. A later publication must still pass normal source, hash, reconciliation, and origin-policy validation.

`finalizePublication` and `refreshObservation` schedule `markActiveSnapshotDelayed` with both active publication ID and latest observation sequence. The guard returns without writing when either value has changed, so an unchanged but successfully observed catalog does not become falsely delayed from an older timer.

## Data Flow

Before first publication to a new/replaced deployment, the worker runs phased `sync-blocks` from PostgreSQL and verifies the terminal sequence/count/set-hash receipt. Existing deployments repeat sync whenever reconciliation detects drift; public reads may continue, but start/finalize remain closed until sync is ready.

1. The worker receives a committed `publish` or `refresh` observation, current PostgreSQL block sequence/count/set hash, and its reserved ledger row from `tech-001`, then marks the row `publishing`.
2. For `publish`, it signs `start`, sends deterministic pack/query-shard batches, and signs `finalize`; for `refresh`, it signs only the metadata action against the expected active publication.
3. Convex records one idempotent operation receipt; finalize atomically changes the active pointer, while refresh changes only observation/freshness fields.
4. The worker acknowledges `published` or `unchanged` with the returned Convex publication/version receipt; after an acknowledgement failure it calls signed `status` before replaying.
5. Abort/failure keeps the last safe complete snapshot; confirmed rollback blocks unsafe outgoing data and either activates a validated safe target or clears public availability.

If `start` returns `unchanged` because another worker already activated identical content/config, the publisher sends the current operation's signed `refresh` metadata, sends no batch/finalize call, and acknowledges its PostgreSQL ledger row as `unchanged`.

## Error Handling and Edge Cases

### Authentication and transport

- Missing/unknown key ID, bad digest/signature, stale timestamp, or malformed header returns 401 before parsing publication content.
- Body over 512 KiB, over 250 batch records, invalid JSON, or invalid shared contract returns 400 without a mutation call.
- The publisher retries network, 429, and 5xx failures at most five times with bounded exponential backoff and identical signed content/idempotency.
- A successful response is reported only after Convex returns `{ ok: true }`; transport 2xx with malformed JSON is a failure.
- Secrets and signatures are redacted from logs; public state never contains an auth or transport failure reason.

### Lifecycle and reconciliation

- Same publication/batch/hash is idempotent; same key with changed content is a permanent 409 conflict.
- Finalize before all batches, with duplicate public IDs, wrong count, or wrong hash returns 422 and leaves staging non-public.
- A lower source sequence cannot activate through publication; rollback requires the signed confirmed operation and never treats a blocked snapshot as safe previous state.
- Publisher death leaves an abandoned staging snapshot; retention marks/deletes it after 24 hours without touching active data.
- Empty complete catalogs may activate with zero packs; missing initial publication has no active pointer and returns `SNAPSHOT_UNAVAILABLE` downstream.

An unchanged successful reconciliation must advance `catalogState.latestObservationSequence`, `lastSuccessfulObservationAt`, `dataAsOf`, delayed-source count, and `staleAt` through `refresh`. It must not modify immutable snapshot/config/pack/shard rows or pointers. A stale refresh for an older observation sequence is a source/state conflict, not a freshness regression.

Rollback or clear creates/retains the active canonical manifest fingerprint block before changing pointers. A new publication ID with the same schema/content/config/origin-set hashes remains `BLOCKED_MANIFEST`; a genuinely corrected fingerprint can publish without silently releasing the old block.

`BLOCK_SET_MISMATCH`, incomplete sync, or a fingerprint blocked in either PostgreSQL or Convex stops start/finalize and records an operational reconciliation failure. It never falls back to trusting the rebuildable Convex mirror.

### Public data safety

- Disabled packs never enter a batch; sold-out packs enter with no actionable Pack Link.
- Unapproved or absent media/promo/listing fields are omitted, not replaced with placeholder data.
- Missing EV, price, buyback, or chase is null plus a constrained public reason, never zero or an internal reason.
- A failed refresh preserves active pack records, accepted query context, immutable completion time, and the prior successful-observation time while freshness becomes delayed.
- Convex never writes back to PostgreSQL and never becomes a recovery source for canonical evidence.

### Rollback validation failure

- Missing or mismatched rollback confirmation, an unsafe/unreconciled target, or a changed expected active ID performs no pointer write and records no successful operator receipt.

## Testing and Verification

### Fast automated coverage

- Shared-contract tests reject forbidden fields, unsafe URLs, non-integer money, invalid public reason codes, inconsistent materialized EV values, and configuration/origin-set count or hash mismatches.
- `convex-test` schema/function tests cover phased block-set rebuild/drift, start/finalize rechecks, replay, unchanged refresh/stale guards, safe-target/clear rollback, confirmed unblock, and retention.
- HTTP tests use `t.fetch()` for HMAC scopes, digest, timestamp, rotation, sync limits/hashes, exact status receipt, confirmation/idempotency, blocked fingerprint, and response envelopes.
- Publisher/ledger tests cover deterministic batching, terminal acknowledgements, exact-field lost-ack reconciliation, retry classification, rollback/unblock receipts, and secret-redacted logs.
- Security tests serialize every Convex table fixture and scan for raw payload, tenant, actor, run, revision, wallet, username, credential, and quarantine keys.

### Real-backend and launch coverage

- Run publication against a non-production Convex backend because the mock does not enforce runtime, transaction, row, byte, or search limits.
- Publish 1,500- and 10,000-pack fixtures and record batch count/bytes, activation latency, query-shard reads, sort work, and deterministic relevance-search work.
- Kill the publisher after start and after a middle batch; replay must resume without duplicates and expose no partial snapshot.
- Demonstrate unchanged metadata refresh beyond the old 15-minute deadline, source regression rejection, delayed recovery, safe-target rollback/explicit clear, same-fingerprint republication rejection, corrected-fingerprint publication, and full PostgreSQL rebuild.
- Reconcile PostgreSQL ledger, staged/active Convex counts, public query counts, and rendered counts before live labeling.

### Required checks after implementation

```bash
npm test --workspace @packscout/contracts
npm test --workspace @packscout/services
npm run test:convex
npm run convex:codegen
npm run verify:framework
```

## Open Questions and Risks

No product decisions remain for this slice.

### Implementation prerequisites

- `convex/_generated/ai/guidelines.md` is absent. Generate it, read it completely, and update this draft before implementing if project-specific guidance conflicts with a proposed path or API.
- Convex local/preproduction/live deployments and their scoped HMAC keys must exist before an end-to-end publication can pass.
- PR #1 and `tech-001` must land first; publication must not read canonical tables directly or invent a second snapshot assembler.
- Approved public platform configuration must exist in PostgreSQL; Convex environment variables are not a substitute for versioned product config.
- The authoritative PostgreSQL block set must synchronize and reconcile before a new/replaced Convex deployment accepts publication.

### Measured risks

- Compact query-shard scans can exceed the one-second target if rows are too large; the 10,000-record real-backend test fails acceptance rather than returning partial search or facet results.
- Direction-specific sort-key encoding must reject out-of-range numbers and preserve deterministic ordering for negative EV values and ties.
- One query must keep all compact shards below Convex transaction byte limits; shard creation splits at 96 rows or 48 KiB, whichever comes first.
- HMAC verification depends on Convex runtime Web Crypto and environment behavior; prove it on the generated local backend before wiring production credentials.

## Handoff Notes

1. Generate and read Convex project guidance before creating `convex/schema.ts` or publication functions.
2. Implement schema, authoritative block-set sync, and internal lifecycle mutations before exposing publication routes.
3. Add HMAC HTTP actions and publisher retries only after mutation idempotency tests pass.
4. Prove failure, replay, activation, rollback, sanitization, and 10,000-pack limits on a non-production deployment.
5. Hand the active-snapshot pointer, compact query shards, detail index, and generated public API to the public-query/Next.js integration spec; never expose publication functions to the browser.
