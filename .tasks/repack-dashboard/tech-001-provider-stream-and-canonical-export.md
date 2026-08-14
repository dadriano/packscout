# Technical Spec: Provider Stream and Canonical Export

**ID:** repack-dashboard/tech-001
**Related tasks:** repack-dashboard/001, repack-dashboard/002, repack-dashboard/012
**Depends on technical specs:** none
**Spec status:** draft

## Start Here

After data-pipeline PR #1 at `0dc6bcc` merges, add one sanitized real `catalog`, `pulls`, and `trades` page under `packages/contracts/src/__fixtures__/provider-stream-v2/`; the first result is three failing contract tests that preserve the observed wrapper, cursor, nesting, and casing.

## Purpose

Replace the unlaunched aggregate provider boundary with one evidence-backed stream contract and produce a deterministic, USD-comparable `CatalogSnapshotV1` from canonical PostgreSQL data.

## Current System Context

### Confirmed repository facts

- Current `main` contains only the `frontend` and `admin` workspaces in `package.json`; the paths below marked post-merge arrive from PR #1.
- Post-merge `packages/contracts/src/provider-feed.ts` expects one aggregate `catalog`/`pulls`/`sales` page with `external_id`, non-null source times, one cursor, and no catalog `entity` or `first_seen_at`.
- Post-merge `packages/database/src/schema/ingestion.ts` uses `catalog`/`pull`/`sale`, one checkpoint per configuration revision, and a non-null `sourceTime`.
- Post-merge canonical revisions, relationships, catalog projections, and PackScout Estimated EV remain the foundation in `packages/database/src/schema/canonical.ts` and `packages/services/src/estimated-ev-projection-contracts.ts`.
- `docs/engineering-rules.md` prohibits an unapproved compatibility shim, dual read, dual write, or provider-name branch in generic orchestration.

### Confirmed provider facts

The [provider response-model draft](https://docs.google.com/document/d/1KEVYxWBjcgAl_uk01xs0Ay6CLO9vK37Hsto5dCbWKnE) establishes:

- Every record has `stream`, `platform`, stable `record_id`, nullable `occurred_at`, `collected_at`, and unflattened `data`.
- Pulls add outer `pack_id` and `card_id`; trades add outer `card_id`, `event_type`, nullable `amount`/`currency`, and `tx_hash`.
- Catalog adds `entity: "pack" | "card"` and immutable `first_seen_at`; pack and card records share the catalog stream and cursor.
- Pulls and trades are immutable events. Catalog records are mutable snapshots whose `record_id` remains stable across revisions.
- The draft does not define request paths, page wrappers, end-of-stream signaling, rate limits, or whether the three stream cursors advance independently; sanitized real pages remain the authority for those transport facts.

### Confirmed public handoff

- PostgreSQL remains canonical. Convex receives only a complete, rebuildable public snapshot.
- Approved public platform, listing-host, referral, promo, logo, and image-host configuration is versioned in PostgreSQL and copied into the snapshot.
- V1 comparisons are USD-only. The exporter accepts canonical USD or explicitly verified USD-comparable minor units and performs no provider-currency or foreign-exchange conversion.
- Signed EV $ and EV % are materialized by the exporter; an unavailable canonical estimate stays unavailable.
- Top chase uses eligible canonical catalog-asset evidence, never a probability bound or raw provider claim; supported USD value wins, otherwise stable public asset ID selects the named unavailable candidate.

## Proposed Implementation

### Replace the inbound boundary

1. Create `ProviderStreamContractV2` as a discriminated union for `catalog`, `pulls`, and `trades` records.
2. Parse the observed provider page wrapper inside its registered transport adapter and emit one normalized page for the requested stream.
3. Run one import run and durable checkpoint per `(configurationRevisionId, stream)`; pack and card catalog records use the same `catalog` checkpoint.
4. Remove `ProviderFeedPageV1`, its aggregate fixtures, and `sale` naming from the launch adapter in the same change.
5. Reject any attempt to register the same source through both V1 and V2; do not add aliases from `external_id`, `updated_at`, or `sales`.

### Normalize without losing evidence

- Preserve live common envelopes and raw `data` unchanged in protected source evidence; sanitize only the copied golden fixtures.
- Use outer `record_id`, `pack_id`, and `card_id` as authoritative identity and relationship fields; nested lookalikes are evidence only.
- Preserve raw `event_type`, then map trimmed lowercase synonyms to `listed`, `unlisted`, `sale`, `mint`, `transfer`, or `other` in the canonical projection.
- Resolve only approved token-contract mappings to canonical symbols; keep the raw currency reference and never turn a missing amount or currency into zero.
- Preserve nullable `occurred_at`; use `occurred_at ?? collected_at` only as an internal ordering value, never as a fabricated occurred-at timestamp.

### Assemble the public export

1. Resolve the approved PackScout organization and active public-config revisions from server configuration; no export method accepts a tenant selector from a public caller.
2. Open a PostgreSQL `REPEATABLE READ` transaction and read current pack, catalog-asset, relationship, Estimated EV, stream-head, and public-config revisions.
3. Build stable public IDs, approved media/actions, constrained public reason codes, one deterministic chase, and USD-only money fields.
4. Sort records and object keys canonically, compute the manifest/content hash, and compare it with the active publication without reusing an earlier ledger row.
5. Commit a new observation ledger row for every successful reconciliation: return a complete immutable `CatalogSnapshotV1` when content/config changed, or a metadata-only observation referencing the current publication when they did not.

## Code Changes

### Contract and transport paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/contracts/src/provider-stream-contract-v2.ts` | Add V2 record unions, normalized page, validation outcomes, stable error codes, and JSON-safe types. |
| `packages/contracts/src/__fixtures__/provider-stream-v2/` | Add sanitized real page and record fixtures for all three streams; preserve observed raw wrappers. |
| `packages/contracts/src/provider-feed.ts` | Delete the aggregate V1 contract after all imports move; do not leave alias exports. |
| `packages/services/src/provider-adapter.ts` | Add required `stream` to page/connection inputs and normalized outcomes. |
| `packages/services/src/http-cursor-adapter.ts` | Send the observed stream selector, parse the observed wrapper, and validate V2 records before persistence. |

### Persistence and projection paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/database/src/schema/ingestion.ts` | Add per-stream run/checkpoint identity and V2 source fields; replace `sale` with `trade`. |
| `packages/database/src/ingestion-page-batch-writer.ts` | Enforce event immutability, catalog revision behavior, page atomicity, and per-stream checkpoint advancement. |
| `packages/services/src/catalog-projection-contracts.ts` | Rename provenance kinds and add V2 outer identity, first-seen, relationship, source-time, and canonical listing-URL candidate fields. |
| `packages/services/src/event-projection-service.ts` | Project pull/trade identities and canonical lifecycle categories without provider-name branches. |
| `apps/worker/src/provider-worker-composition.ts` | Schedule and resume one run per configured stream and remove aggregate-page assumptions. |

### Transitive V2 cutover paths

| Path group | Required replacement |
|---|---|
| `packages/services/src/provider-import-page-planner.ts` and `provider-import-types.ts` | Replace aggregate page plans, counters, outcomes, and shared-cursor assumptions with one transport stream per plan. |
| `packages/services/src/provider-import-service.ts` and `provider-projection-service.ts` | Carry the requested stream end to end and dispatch accepted records without a V1 aggregate branch. |
| `packages/services/src/provider-adapter-registry.ts` and every provider mapper | Register only V2 adapters/mappers and delete V1 mapper fixtures and aliases in the same cutover. |
| Database quarantine repository/schema plus canonical/core schemas | Carry transport kind `trade`, outer identities, nullable source time, and stream-local evidence through persistence and quarantine. |
| Admin read models, launch harnesses, fixtures, and all affected tests | Rename transport counters and filters, prove V1 removal, and retain canonical lifecycle category `sale` only where a trade event maps to that business meaning. |

`trade` is the transport/source stream kind. `sale` remains a canonical lifecycle category produced from an accepted trade event; it must not remain as an inbound stream enum, checkpoint, run counter, or adapter selector.

### Export paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/contracts/src/catalog-snapshot-v1.ts` | Define `CatalogSnapshotV1`, public reason enums, money/metric shapes, and runtime validation. |
| `packages/database/src/schema/public-catalog.ts` | Add approved public configuration, publication ledger, and authoritative manifest-block ledger. |
| `packages/database/src/public-catalog-export-repository.ts` | Add repeatable-read canonical/config query, deterministic watermark, and active manifest-block check. |
| `packages/services/src/catalog-snapshot-assembler.ts` | Sanitize, derive public metrics/IDs, select chase/media/actions, canonicalize, and hash the export. |
| Package `src/index.ts` files and focused tests | Export only the new contracts and services; remove superseded V1 exports and fixtures. |

### Public configuration editing paths after PR #1 merges

| Path | Change |
|---|---|
| `packages/contracts/src/public-catalog-config.ts` | Define proposal, revision, approval, currency-policy, audit, and stable result schemas. |
| `packages/database/src/public-catalog-config-repository.ts` | Persist revisions, enforce optimistic expected revision, and expose only the fully approved current revision to export. |
| `packages/services/src/public-catalog-config-service.ts` | Validate HTTPS/host/referral/currency policy and enforce distinct Product and Engineering approval actors. |
| `apps/admin/server/routes/public-catalog-config.ts` | Add CSRF-protected propose/read/approve routes with explicit permissions and stable structured errors. |
| `apps/admin/src/api/public-catalog-config.ts` and `apps/admin/src/pages/PublicCatalogConfigPage.tsx` | Provide the authenticated proposal/review surface; browser code calls the admin route and never imports services. |

## Database / Schema Changes

### Ingestion V2 migration

1. Replace the `sale` enum value with `trade`; this is an unlaunched-boundary replacement, not a compatibility migration.
2. Add `stream` to `import_runs`, `import_pages`, outcomes, and quarantine records; make the active-run uniqueness key `(organization_id, provider_id, stream)`.
3. Change checkpoints to `(config_revision_id, stream)` and keep one `catalog` row for both catalog entity kinds.
4. Store `record_id`, nullable `occurred_at`, `collected_at`, nullable `first_seen_at`, `entity`, `pack_id`, `card_id`, raw trade fields, and protected `data` explicitly.
5. Generate one Prisma migration and update schema-validation snapshots; do not keep old columns populated by dual write or add fallback reads.

### Identity and revision constraints

- Pull/trade identity is unique on `(organization_id, provider_id, stream, record_id)`; identical re-observation is a duplicate and conflicting content is quarantined.
- Catalog source revisions are unique on stable identity plus `collected_at` and content hash; changed content creates canonical history under the same entity.
- A catalog `first_seen_at` change for an existing identity is a contract conflict and is quarantined while the last valid canonical revision remains current.
- `occurred_at` is nullable in storage; `collected_at` and catalog `first_seen_at` are required when their stream contract requires them.
- Raw page/record payloads retain the existing protected-evidence retention and tenant foreign-key rules.

### Public configuration and ledger

| Table | Required role and fields |
|---|---|
| `public_platform_config_revisions` | Organization/platform, optimistic revision, display name/logo, listing/image hosts, referral parameters, public promo, explicit USD-comparison currency policy, origin-set hash, content hash, state, and timestamps. |
| `public_platform_config_approvals` | Revision, separate Product and Engineering approval kinds, distinct actor keys, approval times, decision, and immutable audit reason. |
| `catalog_publication_ledger` | Organization, operation/publication UUIDs, monotonic source/observation sequence, watermark, content/config/origin-set hashes, target Convex publication/version, counts, state, error category, and lifecycle timestamps. |
| `catalog_manifest_blocks` | Organization, canonical manifest fingerprint, monotonic block sequence/set hash, state, rollback/clear/release operation IDs, sanitized reason, confirmed actor audit, exact Convex receipts, and timestamps. |

Only one fully approved config revision per organization/platform is current. Product approves partner-facing name/logo/promo copy; Engineering separately approves exact hosts, referrals, and currency policy. The same actor cannot satisfy both approvals. Proposals require the current revision, create an immutable audit row, and return `REVISION_CONFLICT` rather than overwriting concurrent work. Permissions are `public_catalog_config:propose`, `public_catalog_config:approve_product`, and `public_catalog_config:approve_engineering`; routes also enforce existing admin authentication, organization scope, and CSRF protection.

Ledger state is `reserved | publishing | published | unchanged | failed | rolled_back`. Every transition uses an expected prior state and is idempotent for the same operation/result. Terminal acknowledgement requires an exact Convex receipt match on operation ID, terminal kind/idempotency key, request body hash, publication ID, observation sequence, Convex snapshot version, and result. A successful canonical reconciliation always creates a new row: unchanged content references the current publication and carries the new watermark, data-as-of time, observation time, delayed-source count, and stale deadline.

PostgreSQL is authoritative for manifest blocks. Block state is `pending | active | release_pending | released`; export treats the first three as blocked, and any pending transition pauses all new publication until exact receipt reconciliation. Rollback/clear reserves the intended post-block sequence/set hash before calling Convex, then marks `active` after its receipt. Confirmed unblock reserves the intended post-release sequence/set hash, calls Convex, and marks `released` only after its receipt. Lost acknowledgement reconciles through signed status while the conservative PostgreSQL state prevents publication.

If a Convex deployment is lost before a terminal receipt can be recovered, a pending block is conservatively completed as active and `release_pending` reverts to active; release is never inferred. The resulting authoritative active set is then synchronized into the replacement deployment before publication resumes.

## Interfaces, APIs, and Endpoints

### `ProviderStreamContractV2`

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

interface ProviderRecordV2Base {
  readonly stream: "catalog" | "pulls" | "trades";
  readonly platform: string;
  readonly record_id: string;
  readonly occurred_at: string | null;
  readonly collected_at: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

type ProviderStreamRecordV2 =
  | (ProviderRecordV2Base & {
      readonly stream: "catalog";
      readonly entity: "pack" | "card";
      readonly first_seen_at: string;
    })
  | (ProviderRecordV2Base & {
      readonly stream: "pulls";
      readonly pack_id: string;
      readonly card_id: string;
    })
  | (ProviderRecordV2Base & {
      readonly stream: "trades";
      readonly card_id: string;
      readonly event_type: string;
      readonly amount: number | null;
      readonly currency: string | null;
      readonly tx_hash: string;
    });

interface ProviderStreamPageV2 {
  readonly stream: ProviderStreamRecordV2["stream"];
  readonly requestedCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly records: readonly ProviderStreamRecordV2[];
}
```

`ProviderStreamPageV2` is the normalized internal result, not a fabricated provider wrapper. The adapter fixture locks the raw wrapper and maps it once.

### Canonical lifecycle mapping

| Trimmed raw values | Canonical category |
|---|---|
| `list`, `listed`, `listing` | `listed` |
| `unlist`, `unlisted`, `unlisting` | `unlisted` |
| `sale`, `sold`, `buyback` | `sale` |
| `mint`, `minted` | `mint` |
| `transfer`, `transferred`, `shipped` | `transfer`; every other value maps to `other` |

The raw outer value and raw `data` remain protected evidence regardless of canonical category.

### Export service seams

| Interface | Contract |
|---|---|
| `PublicCatalogExportRepository.readCurrentState()` | Runs in one repeatable-read transaction and returns current canonical/config revisions plus stream-head freshness. |
| `CatalogSnapshotAssembler.assemble()` | Returns one validated, canonically ordered `CatalogSnapshotV1` or a stable internal assembly failure. |
| `CatalogPublicationLedger.reserveObservation()` | Always creates one monotonic observation row and returns `publish` with a snapshot or `refresh` with current-publication metadata. |
| `CatalogPublicationLedger.transition()` | Moves one row through an expected state and records the stable Convex receipt or sanitized failure category. |
| `PublicCatalogConfigService` | Proposes and separately approves immutable revisions; export can read only the current dual-approved revision. |

`CatalogSnapshotV1` contains `SnapshotMetadata`, `PackSummary`, `PackDetail`, and `CatalogFacets`. It carries no PostgreSQL UUID, tenant identifier, actor, raw payload, quarantine data, provider secret, or internal reason string.

### Safety-block service seam

| Interface | Contract |
|---|---|
| `CatalogManifestBlockRepository` | Reserves block/release transitions, exposes the monotonic active block set/hash for Convex reseeding, and terminally acknowledges only exact signed receipts. |

### Typed public value matrix

| Field | Published representation | Allowed unavailability and precedence |
|---|---|---|
| Pack price | Optional original display money plus nullable integer USD-comparison minor units; no FX conversion | `PRICE_UNAVAILABLE`, then `CURRENCY_UNSUPPORTED` when a source value exists without approved USD evidence |
| PackScout Gross EV | Integer USD minor units copied from the authoritative estimate | `CURRENCY_UNSUPPORTED`, then `ESTIMATE_INPUT_INCOMPLETE` |
| Signed EV $ | Exact checked integer subtraction `grossEvMinor - priceUsdMinor` | `PRICE_UNAVAILABLE` > `CURRENCY_UNSUPPORTED` > `ESTIMATE_INPUT_INCOMPLETE` |
| Signed EV % | Materialized integer basis points from the pipeline gross-return percentage minus 10,000 basis points | Same precedence as Signed EV $ |

The pipeline calculator already rounds gross value half-up to a minor unit and gross-return percent half-up to `0.01%`. The exporter validates that two-decimal percentage, converts it exactly to basis points, and subtracts `10_000`; it performs no second float rounding.

| Field | Published representation | Allowed unavailability and precedence |
|---|---|---|
| Buyback | Integer basis points plus `sourceKind` equal to `direct` or `derived` for provider-supported coverage | `BUYBACK_UNAVAILABLE` only |
| Top chase | No relation: `topChase: null` plus `topChaseReason: "CHASE_UNAVAILABLE"`; relation: public identity/image plus optional representative USD money | Named with no representative value: `CHASE_UNAVAILABLE`; named with numeric value but non-USD/unapproved currency evidence: `CURRENCY_UNSUPPORTED`; missing chase image remains text-only |

Every available money carries explicit currency and integer minor units. Original display money retains its supported source currency/units as public evidence but never participates in USD sorting unless an approved canonical USD-comparison value also exists.

Chase selection first chooses the highest supported representative USD value, then stable public asset ID. If no eligible related candidate has a comparable value, it chooses the lowest stable public asset ID so identity remains deterministic, then classifies that selected candidate using the exact matrix above; it never ranks unsupported amounts against each other.

## Data Flow

1. The worker fetches one observed page for one configured stream and validates its wrapper before any write.
2. The page writer stores accepted protected evidence, quarantines invalid/conflicting records, and advances only that stream checkpoint in the same transaction.
3. Projection services update catalog history or immutable event entities and enqueue affected Estimated EV recomputation.
4. The export repository reads one stable canonical/config state and reserves a new monotonic observation ledger row.
5. The worker hands `tech-002` either the immutable sanitized `CatalogSnapshotV1` or an unchanged-content freshness observation, then acknowledges the Convex outcome on the same ledger row.

Before publication against a new/replaced Convex deployment, the worker synchronizes the authoritative PostgreSQL active/pending/release-pending block set and verifies its sequence/count/hash. Publication stays disabled until that rebuildable Convex mirror reconciles.

## Error Handling and Edge Cases

### Ingestion failures

- Invalid page wrapper, cursor cycle, non-advancing cursor, or stream mismatch fails the page and leaves its checkpoint unchanged.
- Invalid individual records are quarantined with sanitized field paths while valid siblings follow the existing atomic page policy.
- Repeating an immutable event with the same hash is idempotent; the same `record_id` with different content is `IMMUTABLE_EVENT_CONFLICT`.
- Catalog changes create revisions; changed `first_seen_at`, entity kind, platform, or stable identity is `CATALOG_IDENTITY_CONFLICT`.
- Nullable event time or money remains null; missing relationship IDs, blank transaction hashes, non-finite numbers, and invalid timestamps fail record validation.

### Export failures

- Missing approved organization/configuration fails assembly internally and publishes nothing.
- Non-HTTPS or non-allowlisted media/listing configuration is rejected at config write; unexpected persisted violations fail assembly.
- A non-USD-comparable price, estimate, buyback, or chase value maps to a constrained unavailable field and is never converted.
- A missing chase relationship produces `topChase: null` plus `topChaseReason: CHASE_UNAVAILABLE`; a named chase with no representative value uses `CHASE_UNAVAILABLE`, while a named chase with numeric but non-USD/unapproved currency evidence uses `CURRENCY_UNSUPPORTED`.
- Zero eligible packs after a completed source history creates a valid empty snapshot; no completed source history creates no initial snapshot.

### Publication acknowledgements

- If Convex succeeds but PostgreSQL acknowledgement fails, the worker queries the signed publication-status action from `tech-002` and reconciles the ledger before retrying content.
- Start, finalize, refresh, abort, and rollback outcomes each transition the ledger with the expected prior state; a conflicting acknowledgement stops automation and emits an operational reconciliation failure.

## Testing and Verification

### Automated coverage

- Contract tests cover all three real wrappers, nullable timestamps/money, nested raw data, stream mismatch, and removed required identities.
- Persistence integration tests cover per-stream checkpoints, catalog revisions, event duplicates/conflicts, quarantine, restart, and cursor non-advancement.
- Projection tests cover outer relationship precedence, lifecycle synonyms, unknown event types, and known/unknown currency references.
- Export tests cover repeatable-read coherence, public-ID stability, USD-only values, EV derivation, deterministic chase/config selection, and public reason mapping.
- Determinism tests compare clean rebuild and incremental canonical state byte-for-byte and assert identical manifest/content hashes.

### Configuration and ledger coverage

- Configuration tests cover optimistic revision conflicts, invalid hosts/referrals/currency policy, distinct Product/Engineering actors, permission denial, CSRF, and export of only a dual-approved current revision.
- Ledger tests cover every terminal state, unchanged observations, Convex acknowledgement loss/status reconciliation, retry idempotency, and rollback receipts.
- Manifest-block tests cover pending-state publication pause, same-fingerprint denial, exact rollback/clear/unblock receipts, lost acknowledgement/deployment fallback, and deterministic block-set rebuild/hash.

### Security and launch evidence

- Scan every serialized snapshot fixture for raw `data`, organization/actor/run IDs, wallets, usernames, credentials, and quarantine detail.
- Reconcile per-stream accepted, duplicate, quarantined, canonical, estimated/unavailable, and exported counts.
- Exercise no-cursor history, durable incrementals, restart from every stream checkpoint, and one catalog correction.
- Verify no V1 aggregate parser, fixture, alias export, provider-name branch, or simultaneous V1/V2 registration remains.
- Verify transport `trade` reaches all run/checkpoint/quarantine/admin counters while mapped canonical lifecycle `sale` remains a distinct business category.

### Provider evidence record

- Record the exact observed request, cursor, termination, ordering, expiry, retry, and correction behavior before task `001` completes.

### Required checks after implementation

```bash
npm test --workspace @packscout/contracts
npm test --workspace @packscout/database
npm test --workspace @packscout/services
npm test --workspace @packscout/worker
npm run verify:framework
```

## Open Questions and Risks

No product decisions remain for this slice.

### Evidence prerequisites

- The real provider wrapper, paths, authentication, page-size behavior, termination signal, and rate-limit headers are not in the draft; fixtures must lock them before adapter implementation.
- This spec implements one checkpoint per stream. If sanitized real pages prove a single cursor shared across all three streams, stop before migration and revise the technical contract; do not reinterpret it silently.
- Provider ordering, cursor expiry, full-history start, and correction delivery require preproduction evidence before task `001` can complete.
- The source draft contains real personal fields inside `data`; fixture sanitization must preserve structure while irreversibly replacing identities and secrets.

### Implementation risks

- PR #1 is not on current `main`; builders must merge/rebase it before using the post-merge paths in this spec.
- Changing the event enum from `sale` to `trade` touches ingestion, projections, tests, admin read models, and launch evidence in one atomic migration.
- Float provider amounts cannot become public comparison money without explicit decimals and verified USD comparability.
- Public configuration revisions are security-sensitive because one bad host can turn every snapshot into an unsafe action source.

## Handoff Notes

1. Merge or rebase PR #1 before creating any post-merge module named here.
2. Lock and approve the three sanitized real page fixtures before changing database schema.
3. Land V2 contract, transport, migration, and projections as one no-shim boundary replacement.
4. Land approved PostgreSQL public config and deterministic snapshot assembly after V2 ingestion passes.
5. Hand one validated `CatalogSnapshotV1`/observation, its ledger row, and the authoritative block sequence/count/set hash to `repack-dashboard/tech-002`; do not write Convex from projection code.
