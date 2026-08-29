# Technical Spec: Distributed Database Schema Contract

**ID:** distributed-canonical-warehouse/tech-001
**Related tasks:** distributed-canonical-warehouse/001, distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/004, distributed-canonical-warehouse/005, distributed-canonical-warehouse/006, distributed-canonical-warehouse/007, distributed-canonical-warehouse/008, distributed-canonical-warehouse/009, distributed-canonical-warehouse/010, distributed-canonical-warehouse/011, distributed-canonical-warehouse/012, distributed-canonical-warehouse/013, distributed-canonical-warehouse/014, distributed-canonical-warehouse/015, distributed-canonical-warehouse/016, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018, distributed-canonical-warehouse/019, distributed-canonical-warehouse/020
**Depends on technical specs:** none
**Spec status:** draft

## Purpose

Freeze the database ownership, table inventory, relationships, types, and invariants that builders must implement for the clean distributed PackScout warehouse.

## Current System Context

### Confirmed repository facts

- `packages/database/prisma/schema.prisma` currently generates one Prisma client for one `PACKSCOUT_DATABASE_URL` and models 28 tables in one PostgreSQL database.
- The current generic `canonical_entities`, `canonical_revisions`, `canonical_relationships`, and source-record graph are the legacy design being replaced, not inputs to this schema.
- The current admin implementation depends on `organizations`, `operators`, `operator_memberships`, `operator_sessions`, `auth_rate_limits`, `audit_events`, and `admin_alerts` behavior.
- `convex/schema.ts` currently serves one immutable release graph plus durable `savedRepacks` and `savedCollectibles`; its Heat tables are outside this feature.
- The supplied sample has 203,091 records: 140 pack rows, 84,639 pull rows, and 118,312 market/trade rows across two providers.

### Confirmed design decisions

- The central physical database is exactly `packscout`; each provider database is exactly `packscout_<provider_key>` and can live on an independently scaled PostgreSQL instance.
- `packscout` owns admin access, provider configuration and topology, central observations and alerts, the shared global catalog, and central publication coordination.
- Each `packscout_<provider_key>` owns one provider's canonical catalog, immutable activity, runtime, mixed runs, quarantine, local audit, retention, and promotion state.
- `provider`, `provider_id`, and `provider_key` are canonical new terms. Cross-database IDs are soft references; no foreign key or transaction crosses database authorities.
- The schema is a clean pre-launch replacement. It has no migration, dual read, dual write, legacy compatibility table, source adapter, raw staging model, product normalization, or Heat storage.

The approved publication gate is one immutable manifest entry per provider. Each entry selects that provider's complete release and the compatible complete catalog version used to assemble it; advancing one provider preserves every unrelated entry byte-for-byte.

### Source-of-truth rule

This file is the implementation schema contract. The historical HTML ERD and `docs/postgres-data-model.md` are reference material for prior designs only. A builder must not rename a contracted table, add a generic entity/revision/relationship abstraction, reintroduce streams, or move a table between database authorities without an approved design amendment.

The physical SQL names below are lowercase `snake_case`. Uppercase names in the design conversation are diagram labels for the same tables.

## Proposed Implementation

### Physical database roles

| Database | Enforced authority | Connection rule |
|---|---|---|
| `packscout` | Central control, admin, shared catalog, observer, and publication coordination | One central server-owned client; provider credentials cannot connect here |
| `packscout_<provider_key>` | One provider's canonical and operational authority | Resolved only from a validated central provider ID; one isolated pool per provider target |
| Convex | Immutable public read artifacts, active manifest, indexes, and durable saved items | Server-only publication writes; public queries never connect to PostgreSQL |

Every PostgreSQL database contains one `database_identity` row. Readiness compares that row with `current_database()`, the expected database role, the expected schema version, and, for a provider database, the central provider ID and key. A mismatch fails closed before repositories become available.

### Prisma and migration layout

1. Split the current single schema into an independently generated central Prisma schema and one reusable provider-template Prisma schema.
2. Give each schema its own migrations, parity manifest, generated client, readiness signature, and deploy command.
3. Keep application startup read-only with respect to schema state; migrations remain an explicit release action.
4. Resolve provider database URLs only inside a server-side provider gateway after central organization and topology validation.
5. Cache provider clients by validated target identity with bounded pool size, idle lifetime, and explicit close behavior; never accept a browser-supplied database name or URL.

### Shared SQL conventions

| Concern | Contract |
|---|---|
| IDs | PostgreSQL entity IDs are `uuid`. Checkpoint-bearing ledgers allocate `bigint` sequences by locking their singleton ledger row inside the same transaction; database identities may be used only for histories that are never a synchronization boundary. Public IDs use the deterministic UUIDv5 rules in this spec. |
| Time | All instants are `timestamptz`; immutable facts have `occurred_at` and `created_at`; new mutable domain rows have `created_at`, `updated_at`, and positive `row_version`. Existing admin-support tables retain their current timestamp/version shape where listed. |
| Money | Source money is exact `numeric(38,18)` plus `varchar(42)` currency; probability and rate fields use `numeric(20,18)`. Currency is either an uppercase asset code matching `^[A-Z0-9]{2,12}$` or a token address matching `^0x[0-9A-Fa-f]{40}$`. Amount and currency are both null or both non-null. Public conversion uses an explicit currency exponent and safe integer minor units. |
| JSON | JSONB columns accept only the documented object or array shape and have an application byte limit. JSONB is not a substitute for a relationship, identity, state, amount, or query key. |
| Deletion | Local foreign keys use `ON DELETE RESTRICT`. Referenced canonical rows retire in place. Facts, events, changes, and receipts are append-only. Attempts and operations expose controlled one-way state transitions but immutable identity/request fields; ordinary application roles cannot delete them. |

Every table carrying `row_version` uses compare-and-swap. A material update increments it once; a semantic no-op changes neither `updated_at` nor `row_version`. Every canonical material change and its promotion-change row commit in the same local transaction.

### Stable enum vocabulary

#### Central states

- `operator_state`: `active | disabled`; `operator_role`: `admin | data_operator`; `audit_outcome`: `success | failure | blocked`.
- `provider_lifecycle`: `draft | active | disabled | archived`; `credential_lifecycle`: `active | retired | revoked`.
- `credential_kind`: `source | database`; `connection_test_kind`: `source | database | activation`; `connection_test_outcome`: `succeeded | failed`.
- `alert_state`: `active | acknowledged | resolved`; `severity`: `info | warning | critical`.
- `catalog_identity_state`: `provisional | canonical | retired`; `category_kind`: `vertical | sport | league | franchise | brand | set | other`; `correlation_method`: `deterministic | manual | provisional`; `suggestion_state`: `pending | accepted | rejected | superseded`.

#### Provider states

- `entity_lifecycle`: `active | retired`; `availability_state`: `available | sold_out | unavailable`; `evidence_state`: `complete | partial | unknown`; `pack_format`: `repack | gacha`.
- `collectible_type`: `card | watch | art | coin | sealed_product | memorabilia | other`; `content_role`: `top_chase | featured_chase | possible_outcome | other`; chase evidence: `vendor_inventory | vendor_odds | vendor_featured_chase | packscout_resolved | historical_pull_inference | name_only`.
- `market_event_type`: `sale | buyback | mint | burn | transfer | list | unlist | swap | ship | other`.
- `runtime_state`: `idle | running | paused | stopped | error`; `worker_role`: `import | promotion`.
- `run_state`: `queued | running | succeeded | incomplete | failed`; `run_trigger`: `scheduled | manual | recovery`; `page_continuation`: `more | head`.

#### Recovery and publication states

- `command_type`: `run | pause | resume | stop | retry_run | retry_quarantine`; `command_state`: `pending | accepted | rejected | completed | failed`.
- `quarantine_state`: `open | resolved | expired`; `quarantine_attempt_state`: `running | succeeded | failed`.
- `retention_state`: `running | succeeded | failed`; `promotion_operation`: `upsert | retire`.
- `artifact_lifecycle`: `building | assembled | publishing | complete | blocked | failed`; `publication_operation_state`: `pending | accepted | ambiguous | failed`.
- `manifest_operation`: `advance | add | remove | rollback`. There is no `clear` operation.

`activity_origin` is `provider | central`. `activity_delivery_state` is `pending | delivered`; a delivery failure leaves the row pending with bounded retry evidence. `publication_receipt_outcome` is `accepted | rejected`.

## Code Changes

### Database package

- Replace the one-client assumption in `packages/database/src/database.ts` with distinct central and provider client lifecycles and role-aware readiness checks.
- Create central and provider Prisma schema/migration roots under `packages/database/prisma/`; do not keep the old schema as a runtime fallback.
- Split repositories into central ownership, provider canonical ownership, provider runtime ownership, and publication coordination while keeping exports server-only.
- Replace the one global Prisma composition in `apps/admin/server/index.ts` with one central client and a bounded provider gateway.
- Extend schema parity tooling so it verifies both roles, every native constraint/index, and the absence of forbidden legacy tables.

### Contracts and services

- Update the provider contract once from `platformKey` to `providerKey`; do not add a dual-field compatibility alias.
- Update mixed-run counters once from `sales` to `marketEvents`, with optional bounded counts by market-event type.
- Keep current admin route families and role behavior while routing provider-local reads through `providerId` plus the provider gateway.
- Add server-only repository/service contracts for canonical page commits, correlation checkpoints, release assembly, publication operations, manifest activation, and the shared canonical-byte/hash utility currently local to Convex.
- Extend the public collectible type contract with first-class `art`; do not silently map an approved type to `other`.

### Convex boundary

- Replace the single all-provider release pointer with catalog versions, provider releases, immutable manifest revisions, and one active-manifest pointer.
- Keep current public query and saved-item function names so the frontend surface does not require a route redesign.
- Keep saved items outside immutable artifact cleanup and continue deriving ownership from verified Convex auth.
- Remove Heat from this feature's target schema and make its public wrapper explicitly unavailable without blocking catalog reads.
- Keep publication entry points internal/server-only with argument validators, bounded batches, idempotency keys, digests, and receipt lookup.

## Database / Schema Changes

### Notation

`PK` is primary key, `FK` is a same-database foreign key, `soft` is a validated cross-database identifier, `UK` is unique, and `?` is nullable. `ts` means `timestamptz`. Unless stated otherwise, UUID primary keys default to `gen_random_uuid()`, timestamps default to `now()`, and local foreign keys restrict deletion.

### Central `packscout`: identity and access

These current physical names remain because the user approved porting the existing admin implementation rather than renaming it. Their existing constraints are retained exactly unless this table contract explicitly adds a field.

| Table | Required columns | Keys and invariants |
|---|---|---|
| `database_identity` | `singleton_key boolean PK=true`, `database_role text`, `schema_version text`, `provider_id uuid?`, `provider_key text?`, `created_at ts` | Check singleton is true; central row requires role `central` and null provider fields |
| `organizations` | `id uuid PK`, `slug text`, `name text`, `created_at ts` | UK `slug`; nonblank slug/name |
| `operators` | `id uuid PK`, `email_normalized text`, `display_name text`, `password_hash text`, `state operator_state`, `created_at ts`, `updated_at ts` | UK `email_normalized`; normalized lowercase email; nonblank display name |
| `operator_memberships` | `id uuid PK`, `organization_id uuid FK`, `operator_id uuid FK`, `role operator_role`, `created_at ts`, `updated_at ts` | UK `(organization_id, operator_id)`; index `operator_id` |
| `operator_sessions` | `id uuid PK`, `organization_id uuid FK`, `operator_id uuid FK`, `token_hash text`, `csrf_hash text`, `idle_expires_at ts`, `absolute_expires_at ts`, `last_seen_at ts`, `revoked_at ts?`, `created_at ts` | UK `token_hash`; composite FK to membership; `created_at <= idle_expires_at <= absolute_expires_at` |

### Central `packscout`: security history

| Table | Required columns | Keys and invariants |
|---|---|---|
| `auth_rate_limits` | `bucket_key text PK`, `window_started_at ts`, `attempt_count int=0`, `blocked_until ts?`, `updated_at ts` | `attempt_count >= 0` |
| `audit_events` | `id uuid PK`, `organization_id uuid? FK`, `actor_key text`, `action text`, `subject_type text`, `subject_id uuid?`, `outcome audit_outcome`, `metadata_json jsonb={}`, `occurred_at ts` | Append-only; index `(organization_id, occurred_at desc)`; bounded allowlisted metadata |

### Central `packscout`: provider registry and topology

| Table | Required columns | Keys and invariants |
|---|---|---|
| `providers` | `id uuid PK`, `organization_id uuid FK`, `provider_key varchar(53)`, `display_name text`, `lifecycle provider_lifecycle`, `active_config_version_id uuid?`, `active_public_profile_version_id uuid?`, `topology_version bigint=1`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Global UK `provider_key`; UK `(id,organization_id)`; key regex `^[a-z][a-z0-9_]{0,52}$`; composite provider-ownership FKs select active config/profile versions |
| `provider_public_profile_versions` | `id uuid PK`, `provider_id uuid FK`, `version_number bigint`, `display_name text`, `logo_url text?`, `website_url text?`, `listing_hosts text[]`, `image_origins text[]`, `referral_parameters jsonb=[]`, `promo_code text?`, `promo_label text?`, `content_hash char(64)`, `created_by_operator_id uuid FK`, `created_at ts` | UK `(provider_id,version_number)` and `(id,provider_id)`; immutable; HTTPS/host rules match the current public DTO; arrays are bounded/sorted/unique; referral JSON is an exact bounded sorted `{name,value}` array; promo fields pair; logo origin must be allowlisted |
| `provider_config_versions` | `id uuid PK`, `provider_id uuid FK`, `version_number bigint`, `adapter_key text`, `endpoint_url text`, `source_credential_version_id uuid?`, `schedule_seconds int`, `stale_after_seconds int`, `configuration jsonb={}`, `expires_at ts?`, `created_by_operator_id uuid FK`, `created_at ts` | UK `(provider_id,version_number)` and `(id,provider_id)`; composite FK owns the credential to the provider and a constraint trigger requires kind `source`; immutable; schedule `>=60`; stale `>0`; null expiry means no expiry |
| `provider_credential_versions` | `id uuid PK`, `provider_id uuid FK`, `credential_kind credential_kind`, `version_number bigint`, `ciphertext bytea`, `nonce bytea`, `auth_tag bytea`, `key_version int`, `lifecycle credential_lifecycle`, `activated_at ts?`, `retired_at ts?`, `revoked_at ts?`, `created_at ts` | UK `(provider_id,credential_kind,version_number)` and `(id,provider_id)`; immutable ciphertext; `key_version>0`; lifecycle/time consistency |
| `provider_database_nodes` | `id uuid PK`, `provider_id uuid FK`, `node_key text`, `node_role text`, `host text`, `port int`, `database_name text`, `ssl_mode text`, `credential_version_id uuid`, `region text?`, `enabled boolean`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `(provider_id,node_key)` and `(id,provider_id)`; composite FK owns the credential to the provider and a constraint trigger requires kind `database`; one partial-UK enabled primary/provider; port `1..65535`; constraint trigger verifies derived database name and increments provider topology/version on enabled routing changes |
| `provider_connection_tests` | `id uuid PK`, `provider_id uuid FK`, `config_version_id uuid`, `source_credential_version_id uuid?`, `database_credential_version_id uuid?`, `topology_version bigint`, `database_node_id uuid?`, `database_node_row_version bigint?`, `target_digest char(64)`, `test_kind connection_test_kind`, `outcome connection_test_outcome`, `latency_ms int?`, `response_status int?`, `sanitized_code text?`, `result_summary jsonb={}`, `record_counts jsonb?`, `has_more boolean?`, `next_cursor_present boolean?`, `tested_by_operator_id uuid FK`, `tested_at ts`, `created_at ts` | Composite ownership FKs bind provider, config, credentials, and node; activation requires the exact source/database credential IDs, topology, node version, and digest; append-only; provider/config and provider/kind/time indexes; numeric bounds |

There is no configuration approval state. Activation requires one non-expired immutable configuration and a successful `activation` test for that exact configuration ID and current `topology_version`. Editing config, credentials, or topology invalidates eligibility until the new exact combination passes.

Every provider-scoped central write carrying an operator ID uses a deferrable constraint trigger to require an `operator_memberships` row for that provider's organization. A raw operator FK alone is never sufficient authorization or tenant ownership.

### Central `packscout`: observation and alerts

| Table | Required columns | Keys and invariants |
|---|---|---|
| `provider_activity_events` | `id uuid PK`, `organization_id uuid FK`, `provider_id uuid`, `origin activity_origin`, `event_digest char(64)`, `event_type text`, `severity severity`, `dedupe_key text`, `recovery_key text`, `local_run_id uuid? soft`, `local_quarantine_id uuid? soft`, `title text`, `summary text`, `evidence jsonb={}`, `event_at ts`, `received_at ts`, `created_at ts` | Composite FK `(provider_id,organization_id)` owns the event; provider-origin ID equals the provider-local outbox event ID and central-origin ID is observer-generated; UK `(provider_id,id)` supports ownership FKs; append-only; same ID/digest is idempotent and changed digest conflicts; only provider-origin rows may carry local refs; bounded copy/evidence |
| `provider_health` | `provider_id uuid PK`, `organization_id uuid FK`, `last_activity_event_id uuid?`, `last_activity_at ts?`, `observed_state text`, `freshness_state text`, `quality_state text`, `consecutive_failures int=0`, `open_quarantine_count int=0`, `last_attempted_at ts?`, `last_head_reached_at ts?`, `recovered_at ts?`, `last_direct_probe_at ts?`, `last_runner_heartbeat_at ts?`, `latest_failure_code text?`, `recovery_hint text?`, `latest_mapping_warning_at ts?`, `mapping_warning_severity text?`, `mapping_warning_active boolean=false`, `latest_calculation_warning_at ts?`, `calculation_warning_severity text?`, `calculation_warning_active boolean=false`, `publication_lag bigint=0`, `observed_at ts`, `row_version bigint=1`, `updated_at ts` | Composite provider/organization and `(provider_id,last_activity_event_id)` activity FKs; counts nonnegative; activity ID/time pairs; warning field consistency; one cached row/provider; every response exposes observation time and derived staleness |
| `admin_alerts` | `id uuid PK`, `organization_id uuid FK`, `latest_activity_event_id uuid?`, `kind text`, `severity severity`, `state alert_state`, `dedupe_key text`, `recovery_key text`, `title text`, `summary text`, `provider_id uuid?`, `run_id uuid? soft`, `quarantine_id uuid? soft`, `first_seen_at ts`, `last_seen_at ts`, `occurrence_count int=1`, `reopened_count int=0`, `acknowledged_by_actor_key text?`, `acknowledged_at ts?`, `resolved_by_actor_key text?`, `resolved_at ts?` | UK `(organization_id,dedupe_key)`; composite FKs enforce provider organization and activity ownership when present; counts positive/nonnegative; state/time and actor/time checks; index organization/state/last seen; append history through activity/audit rows; no local run/quarantine FK |

`provider_activity_events` supersedes the old central `operational_events` table. Admin behavior is preserved through the repository/service projection, not through a second compatibility table.

### Central `packscout`: shared global identities

| Table | Required columns | Keys and invariants |
|---|---|---|
| `global_categories` | `id uuid PK`, `parent_category_id uuid? FK`, `category_key text`, `display_name text`, `category_kind category_kind`, `display_order int=0`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `category_key`; nonnegative display order; no self-parent; deferred acyclic-tree trigger; index parent/lifecycle/order |
| `global_collectibles` | `id uuid PK`, `primary_category_id uuid? FK`, `collectible_type collectible_type`, `identity_state catalog_identity_state`, `display_name text`, `normalized_name text`, `year int?`, `brand text?`, `set_or_series text?`, `card_number text?`, `reference_number text?`, `subject text?`, `grade text?`, `grader text?`, `primary_image_url text?`, `primary_image_alt text?`, `valuation_amount numeric(38,18)?`, `valuation_currency varchar(42)?`, `valuation_usd_amount numeric(38,18)?`, `valuation_unavailable_reason text?`, `valuation_type text?`, `valuation_observed_at ts?`, `data_as_of ts`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | ID is `publicCollectibleId`; paired/bounded image and valuation fields; exact valuation type/reason allowlists; year `1000..9999`; index `(collectible_type,normalized_name)` and identity state |
| `global_collectible_categories` | `id uuid PK`, `global_collectible_id uuid FK`, `global_category_id uuid FK`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Partial UK active `(global_collectible_id,global_category_id)`; primary category must have one active link when non-null; retired categories cannot be newly linked; retire instead of delete; link ID is the promotion-change identity |
| `global_collectible_name_aliases` | `id uuid PK`, `global_collectible_id uuid FK`, `display_name text`, `normalized_name text`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Partial UK active `(global_collectible_id,normalized_name)`; immutable normalized text; bounded to 32 active names per collectible for the current public contract; retire instead of delete |
| `provider_category_correlations` | `id uuid PK`, `provider_id uuid FK`, `local_category_id uuid soft`, `local_entity_version bigint`, `global_category_id uuid FK`, `correlation_version bigint`, `rule_version text`, `method correlation_method`, `confidence numeric(5,4)`, `valid_from_event_sequence bigint FK`, `valid_to_event_sequence bigint? FK`, `valid_from ts`, `valid_to ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `(provider_id,local_category_id,correlation_version)`; partial UK active `(provider_id,local_category_id)`; only a CAS-protected null-to-value close may change end fields; sequence/time interval and confidence checks |
| `provider_collectible_correlations` | Same temporal columns as category correlation using `local_collectible_id` and `global_collectible_id` | Same active/version uniqueness and close-only history; collectible types must be compatible; local ID/version are soft refs |
| `correlation_suggestions` | `id uuid PK`, `provider_id uuid FK`, `local_collectible_id uuid soft`, `local_entity_version bigint`, `provisional_collectible_id uuid FK`, `candidate_collectible_id uuid FK`, `rule_version text`, `confidence numeric(5,4)`, `review_state suggestion_state`, `decision_event_sequence bigint FK`, `rationale jsonb={}`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Candidate differs from provisional; one active pending suggestion per provider/local/candidate/rule; every state decision has catalog history; suggestions never alter identity automatically |

### Central `packscout`: catalog history and change tracking

| Table | Required columns | Keys and invariants |
|---|---|---|
| `catalog_ledger` | `singleton_key boolean PK=true`, `last_sequence bigint=0`, `updated_at ts` | Check singleton and nonnegative sequence; writers lock this row and allocate a contiguous range before inserting decision/change rows in the same transaction |
| `collectible_aliases` | `alias_collectible_id uuid PK FK`, `canonical_collectible_id uuid FK`, `decision_event_sequence bigint FK`, `created_at ts` | Append-only; alias differs from target; deferred acyclic-alias trigger; target resolves to a surviving identity |
| `catalog_decision_events` | `sequence bigint PK`, `event_type text`, `actor_type text`, `actor_id text`, `reason text`, `before_state jsonb?`, `after_state jsonb?`, `occurred_at ts`, `created_at ts` | Sequence comes from `catalog_ledger`; append-only; bounded states/reason; supports provisional, link, suggestion, replacement, retirement, and alias decisions |
| `catalog_promotion_changes` | `sequence bigint PK`, `decision_event_sequence bigint FK`, `provider_id uuid? FK`, `entity_type text`, `entity_id uuid`, `entity_version bigint`, `operation promotion_operation`, `changed_at ts`, `created_at ts` | Sequence comes from `catalog_ledger`; append-only; UK `(entity_type,entity_id,entity_version,operation)`; allowlist is `global_category`, `global_collectible`, `global_collectible_category`, `global_collectible_name_alias`, `collectible_alias`, `provider_category_correlation`, or `provider_collectible_correlation`; provider ID required for correlation-triggered provider release work |
| `provider_release_invalidation_ledger` | `singleton_key boolean PK=true`, `last_sequence bigint=0`, `updated_at ts` | Row-locked commit-ordered allocator for provider release invalidations |
| `provider_release_invalidations` | `sequence bigint PK`, `provider_id uuid FK`, `catalog_change_sequence bigint? FK`, `public_profile_version_id uuid? FK`, `reason text`, `created_at ts` | Append-only; sequence comes from invalidation ledger; exactly one cause; UK per provider/cause; catalog or profile activation writes one row for every provider whose released projection may change |
| `provider_invalidation_checkpoints` | `provider_id uuid PK FK`, `last_confirmed_invalidation_sequence bigint=0`, `confirmed_provider_release_id uuid? soft`, `row_version bigint=1`, `updated_at ts` | Monotonic; nonzero confirmation requires a complete provider release/receipt; catalog/profile retention cannot pass unconfirmed affected-provider invalidations |
| `catalog_consumer_checkpoints` | `consumer_key text PK`, `last_confirmed_sequence bigint=0`, `confirmation_id text?`, `lease_owner text?`, `lease_fence bigint=0`, `lease_expires_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Seed key `catalog_publication`; monotonic checkpoint/fence; nonzero confirmation requires exact accepted catalog receipt; lease fields all null or all present; stale fence cannot advance |

A provisional global collectible ID is deterministic UUIDv5 from the provider ID plus local collectible ID. Ambiguous evidence keeps that provisional identity and adds suggestions. Global identity, alias, correlation, and active public-profile changes materialize affected provider invalidations in the same transaction so each required provider rebuild has a durable checkpoint path.

### Central `packscout`: catalog and manifest publication

| Table | Required columns | Keys and invariants |
|---|---|---|
| `catalog_versions` | `id uuid PK`, `predecessor_id uuid? FK`, `through_change_sequence bigint`, `schema_version text`, `lifecycle artifact_lifecycle`, `category_count int`, `collectible_count int`, `alias_count int`, `content_hash char(64)`, `created_at ts`, `assembled_at ts?`, `completed_at ts?` | Descriptor/batches immutable after `assembled`; partial UK `(schema_version,content_hash) WHERE lifecycle='complete'` reuses unchanged output; nonnegative counts; lifecycle/time consistency |
| `catalog_version_batches` | `id uuid PK`, `catalog_version_id uuid FK`, `batch_kind text`, `batch_index int`, `payload jsonb`, `record_count int`, `byte_count int`, `body_hash char(64)`, `created_at ts` | Kind allowlist categories, collectibles, aliases; UK `(catalog_version_id,batch_kind,batch_index)`; append-only until assembly; bounded canonical payload/count/bytes |
| `catalog_publication_operations` | `id uuid PK`, `catalog_version_id uuid FK`, `operation_kind text`, `batch_index int?`, `idempotency_key text`, `request_digest char(64)`, `request_bytes bytea`, `body_hash char(64)?`, `lease_fence bigint`, `state publication_operation_state`, `convex_receipt_id text?`, `receipt_hash char(64)?`, `receipt jsonb?`, `failure_code text?`, `requested_at ts`, `completed_at ts?` | UK `idempotency_key`; bounded exact bytes; changed bytes under one key conflict; stale fence cannot terminalize; controlled one-way state with immutable terminal receipt |
| `manifest_activation_state` | `singleton_key boolean PK=true`, `active_manifest_id text? soft`, `active_manifest_fingerprint char(64)?`, `previous_manifest_id text? soft`, `previous_manifest_fingerprint char(64)?`, `lease_owner text?`, `lease_fence bigint=0`, `lease_expires_at ts?`, `last_receipt_id text?`, `row_version bigint=1`, `updated_at ts` | Coordination mirror only; Convex remains active-manifest authority; active/previous and lease/fence pairs are consistent |
| `manifest_activation_operations` | `id uuid PK`, `provider_id uuid FK`, `operation manifest_operation`, `expected_manifest_id text? soft`, `target_provider_release_id uuid? soft`, `target_catalog_version_id uuid? FK`, `new_manifest_fingerprint char(64)`, `idempotency_key text`, `request_digest char(64)`, `lease_fence bigint`, `state publication_operation_state`, `convex_receipt_id text?`, `receipt_hash char(64)?`, `receipt jsonb?`, `requested_by_operator_id uuid? FK`, `requested_at ts`, `completed_at ts?` | UK `idempotency_key`; one operation changes one provider entry and requires the exact release/catalog pair when applicable; append intent before network call; stale fence cannot terminalize; terminal receipt immutable |
| `artifact_retention_executions` | `id uuid PK`, `state retention_state`, `cutoff_at ts`, `batch_size int`, `selected_count int=0`, `deleted_count int=0`, `protected_count int=0`, `failed_count int=0`, `failure_code text?`, `started_at ts`, `finished_at ts?`, `created_at ts` | Counts nonnegative; cleanup protects active, previous, in-flight, blocked, and authorized rollback manifests plus every referenced catalog/provider artifact; if any cross-database or Convex root cannot be proven, the run makes zero deletions |

Catalog snapshot construction runs at `REPEATABLE READ`, captures the visible catalog-ledger boundary inside that snapshot, and finalizes its counts and hashes before commit. Constraint triggers reject new batches after assembly and require category parents, aliases, counts, and ordered batch hashes to reconcile. A later mutable catalog write therefore cannot alter or be mistaken for that version.

### Provider `packscout_<provider_key>`: identity and catalog

| Table | Required columns | Keys and invariants |
|---|---|---|
| `database_identity` | `singleton_key boolean PK=true`, `database_role text`, `schema_version text`, `provider_id uuid soft`, `provider_key varchar(53)`, `created_at ts` | Role must be `provider`; provider fields non-null; key/name must match the validated central target |
| `categories` | `id uuid PK`, `parent_category_id uuid? FK`, `category_key text`, `display_name text`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `category_key`; no self-parent; deferred acyclic-tree trigger; index parent/lifecycle |
| `packs` | `id uuid PK`, `category_id uuid? FK`, `pack_key text`, `family_key text?`, `display_name text`, `description text?`, `pack_format pack_format`, `lifecycle entity_lifecycle`, `availability availability_state`, `content_evidence evidence_state`, `total_inventory bigint?`, `remaining_inventory bigint?`, `price_amount numeric(38,18)?`, `price_currency varchar(42)?`, `price_usd_amount numeric(38,18)?`, `price_unavailable_reason text?`, `buyback_rate numeric(20,18)?`, `buyback_source_kind text?`, `vendor_ev_amount numeric(38,18)?`, `vendor_ev_currency varchar(42)?`, `vendor_ev_observed_at ts?`, `vendor_ev_unavailable_reason text?`, `packscout_ev_amount numeric(38,18)?`, `packscout_ev_currency varchar(42)?`, `packscout_ev_model_version text`, `packscout_ev_confidence_policy_version text`, `packscout_ev_confidence jsonb?`, `packscout_ev_data_as_of ts?`, `packscout_ev_calculated_at ts?`, `packscout_ev_unavailable_reason text?`, `primary_image_url text?`, `primary_image_alt text?`, `listing_url text?`, `attributes jsonb={}`, `source_updated_at ts`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `pack_key`; paired nonnegative money/image fields and exact unavailable-reason/source allowlists; confidence JSON is the exact bounded `{scoreBasisPoints,band,limitationCodes}` public shape; inventory nonnegative and remaining <= total; buyback `0..1`; lifecycle/time consistency; category/availability indexes |
| `collectibles` | `id uuid PK`, `category_id uuid? FK`, `collectible_key text`, `collectible_type collectible_type`, `display_name text`, `normalized_name text`, `year int?`, `brand text?`, `set_or_series text?`, `card_number text?`, `reference_number text?`, `subject text?`, `grade text?`, `grader text?`, `primary_image_url text?`, `primary_image_alt text?`, `valuation_amount numeric(38,18)?`, `valuation_currency varchar(42)?`, `valuation_usd_amount numeric(38,18)?`, `valuation_unavailable_reason text?`, `valuation_type text?`, `valuation_observed_at ts?`, `data_as_of ts`, `lifecycle entity_lifecycle`, `attributes jsonb={}`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `collectible_key`; bounded/paired identity, image, and valuation fields; exact valuation type/reason allowlists; year/value checks; indexes category/type/name/lifecycle |
| `collectible_name_aliases` | `id uuid PK`, `collectible_id uuid FK`, `display_name text`, `normalized_name text`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Partial UK active `(collectible_id,normalized_name)`; bounded names; retire instead of delete |
| `collectible_instances` | `id uuid PK`, `collectible_id uuid FK`, `instance_key text`, `certifier text?`, `certification_number text?`, `lifecycle entity_lifecycle`, `attributes jsonb={}`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `instance_key`; UK `(id,collectible_id)` for composite ownership FKs; index collectible/lifecycle |

Nullable category IDs intentionally mean unclassified canonical data, not a broken reference. They may remain private, but a released category/collectible reference must exist in the pinned complete catalog version. Type-specific `attributes` are versioned provider-private objects and cannot supply a public field that lacks a typed column above.

### Provider `packscout_<provider_key>`: contents and immutable facts

| Table | Required columns | Keys and invariants |
|---|---|---|
| `pack_contents` | `id uuid PK`, `pack_id uuid FK`, `collectible_id uuid FK`, `collectible_instance_id uuid?`, `total_quantity bigint?`, `available_quantity bigint?`, `content_role content_role`, `probability numeric(20,18)?`, `stated_value_amount numeric(38,18)?`, `stated_value_currency varchar(42)?`, `evidence_kinds text[]`, `match_confidence_basis_points int`, `match_confidence_band text`, `observed_at ts`, `display_order int`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Composite FK `(instance_id,collectible_id)`; quantities nonnegative/ordered; probability `0..1`; nonnegative money pair; public chase evidence is bounded/sorted/nonempty and confidence band matches `0..10000`; nonnegative display order; one partial UK active `top_chase` per pack plus exact/non-exact content identity UKs |
| `provider_accounts` | `id uuid PK`, `account_key char(64)`, `display_name text?`, `attributes jsonb={}`, `lifecycle entity_lifecycle`, `retired_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `account_key`; key is lowercase hex HMAC-SHA256 of the source account identity using a provider-scoped pseudonymization secret held outside this database; raw identity is never stored or published |
| `pulls` | `id uuid PK`, `pull_key text`, `fact_digest char(64)`, `pack_id uuid FK`, `provider_account_id uuid? FK`, `occurred_at ts`, `paid_amount numeric(38,18)?`, `paid_currency varchar(42)?`, `created_at ts` | UK `pull_key`; digest covers the pull and ordered item facts; same key/digest replays and changed digest conflicts; append-only; nonnegative money pair; indexes `(pack_id,occurred_at desc)` and account/time |
| `pull_items` | `id uuid PK`, `pull_id uuid FK`, `ordinal int`, `collectible_id uuid FK`, `collectible_instance_id uuid?`, `quantity bigint`, `stated_value_amount numeric(38,18)?`, `stated_value_currency varchar(42)?`, `created_at ts` | UK `(pull_id,ordinal)`; composite instance/collectible FK; positive ordinal/quantity; nonnegative money pair; append-only |
| `market_events` | `id uuid PK`, `event_key text`, `fact_digest char(64)`, `event_group_id uuid?`, `event_type market_event_type`, `pack_id uuid? FK`, `collectible_id uuid? FK`, `collectible_instance_id uuid?`, `from_provider_account_id uuid? FK`, `to_provider_account_id uuid? FK`, `quantity bigint?`, `occurred_at ts`, `amount numeric(38,18)?`, `currency varchar(42)?`, `details jsonb={}`, `created_at ts` | UK `event_key`; same key/digest replays and changed digest conflicts; at least one local subject; instance requires/matches collectible; quantity is positive when known; nonnegative money pair; append-only; indexes group/type/time and each subject/time |

A deferred constraint trigger rejects a committed `pulls` row without at least one `pull_items` row. Compound transfers or swaps use multiple atomic market rows with one deterministic `event_group_id`; individual amounts and directions remain on each row.

### Provider `packscout_<provider_key>`: canonical change ledger

| Table | Required columns | Keys and invariants |
|---|---|---|
| `promotion_ledger` | `singleton_key boolean PK=true`, `last_sequence bigint=0`, `updated_at ts` | Check singleton and nonnegative sequence; writers lock this row and allocate a contiguous range before inserting changes in the same transaction |
| `promotion_changes` | `sequence bigint PK`, `entity_type text`, `entity_id uuid`, `entity_version bigint`, `operation promotion_operation`, `changed_at ts`, `created_at ts` | Sequence comes from `promotion_ledger`; append-only; UK `(entity_type,entity_id,entity_version,operation)`; allowlist is `category`, `pack`, `collectible`, `collectible_name_alias`, `collectible_instance`, `pack_content`, `provider_account`, `pull`, `pull_item`, or `market_event`; immutable facts use version `1`; no `stream_id` |

Every insert, material update, immutable-fact insertion, or retirement covered by the public/correlation change contract appends exactly one ordered change. A failed transaction leaves neither a changed entity nor an orphan change.

### Provider `packscout_<provider_key>`: runtime and mixed runs

| Table | Required columns | Keys and invariants |
|---|---|---|
| `provider_runtime` | `singleton_key boolean PK=true`, `central_provider_id uuid soft`, `provider_key text`, `operating_state runtime_state`, `state_reason text?`, `state_generation bigint=0`, `cached_config_version_id uuid? soft`, `cached_config_version_number bigint?`, `cached_configuration jsonb?`, `config_expires_at ts?`, `last_control_sync_at ts?`, `schedule_seconds int?`, `next_due_at ts?`, `source_cursor jsonb?`, `source_cursor_hash char(64)?`, `freshness_state text`, `quality_state text`, `consecutive_failures int=0`, `latest_failure_code text?`, `last_attempted_at ts?`, `last_head_reached_at ts?`, `last_runner_heartbeat_at ts?`, `recovered_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Singleton; provider ID/key match `database_identity` by constraint trigger; reason required for paused/stopped/error and null otherwise; cached config ID/number/body/sync/schedule are all present after initialization or all null before first sync; expiration remains optional; cursor/hash pair; nonnegative generation/failures; cached config contains no credential |
| `provider_state_events` | `sequence bigint identity PK`, `from_state runtime_state?`, `to_state runtime_state`, `state_generation bigint`, `reason text?`, `actor_type text`, `actor_id text`, `correlation_id uuid`, `occurred_at ts`, `created_at ts` | Append-only; UK `state_generation`; transition/reason matrix enforced |
| `provider_worker_states` | `worker_role worker_role PK`, `lease_owner text?`, `lease_fence bigint=0`, `heartbeat_at ts?`, `lease_expires_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Exactly `import` and `promotion` rows; lease fields all null or all present; fence monotonic |
| `provider_runs` | `id uuid PK`, `control_command_id uuid? FK`, `recovery_of_run_id uuid? FK`, `idempotency_key text`, `trigger run_trigger`, `state run_state`, `requested_by_operator_id uuid? soft`, `config_version_id uuid soft`, `config_version_number bigint`, `worker_fence bigint`, `attempt_number int=1`, `requested_cursor jsonb?`, `requested_cursor_hash char(64)?`, `final_cursor jsonb?`, `final_cursor_hash char(64)?`, `reached_source_head boolean=false`, `page_count int=0`, `catalog_record_count int=0`, `pull_record_count int=0`, `market_event_record_count int=0`, `accepted_count int=0`, `duplicate_count int=0`, `quarantined_count int=0`, `material_change_count int=0`, `failure_code text?`, `failure_class text?`, `failure_summary text?`, `heartbeat_at ts?`, `requested_at ts`, `started_at ts?`, `last_progress_at ts?`, `finished_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `idempotency_key`; partial UK one run/control command; unique constant-expression index `((true)) WHERE state IN ('queued','running')`; recovery trigger/reference pair; all counts nonnegative and roll up committed pages; cursor/status/time checks; terminal outcome immutable |
| `provider_run_pages` | `id uuid PK`, `provider_run_id uuid FK`, `page_number int`, `contract_version text`, `requested_cursor jsonb?`, `requested_cursor_hash char(64)?`, `next_cursor jsonb?`, `next_cursor_hash char(64)?`, `continuation page_continuation`, `response_digest char(64)`, `record_count int`, `catalog_record_count int`, `pull_record_count int`, `market_event_record_count int`, `accepted_count int`, `duplicate_count int`, `quarantined_count int`, `material_change_count int`, `committed_at ts`, `created_at ts` | UK `(id,provider_run_id)`, `(provider_run_id,page_number)`, and `NULLS NOT DISTINCT (provider_run_id,requested_cursor_hash)`; positive page; nonnegative counts; kind and disposition counts each sum to record count; material changes <= accepted; `head` requires null next cursor and `more` requires one; append-only; no raw provider payload |

There is one provider runtime, cursor, schedule, import worker, active run, and run history. Catalog, pull, and market-event values are typed records and counters inside a page, never separate streams or controls. Every provider-local admin projection derives provider identity from the verified `database_identity` singleton; provider IDs are not repeated across all local rows.

### Provider `packscout_<provider_key>`: commands and recovery

| Table | Required columns | Keys and invariants |
|---|---|---|
| `control_commands` | `id uuid PK`, `idempotency_key text`, `command_type command_type`, `target_run_id uuid? FK`, `target_quarantine_id uuid? FK`, `expected_generation bigint`, `requested_by_operator_id uuid soft`, `correlation_id uuid`, `reason text?`, `state command_state`, `result jsonb?`, `resulting_run_id uuid? FK`, `requested_at ts`, `acknowledged_at ts?`, `completed_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | UK `idempotency_key`; retry type requires exactly its matching target and other commands reject targets; reverse run/command IDs must agree; generation/state/time checks; no provider/data-kind stream key |
| `quarantine_records` | `id uuid PK`, `provider_run_id uuid FK`, `provider_run_page_id uuid`, `record_index int`, `record_kind text`, `entity_key text?`, `source_record_key text?`, `external_id text?`, `reason_code text`, `field_path text?`, `sanitized_summary text`, `candidate_schema_version text`, `normalized_candidate jsonb?`, `protected_evidence jsonb?`, `evidence_expires_at ts`, `evidence_expired_at ts?`, `retry_count int=0`, `last_retry_at ts?`, `resolved_at ts?`, `state quarantine_state`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Composite FK `(provider_run_page_id,provider_run_id)` prevents mismatched ownership; UK `(provider_run_page_id,record_kind,record_index)`; nonnegative index/retries; default evidence expiry 90 days; tombstone candidate/evidence, never history |
| `quarantine_attempts` | `id uuid PK`, `quarantine_record_id uuid FK`, `requested_by_operator_id uuid soft`, `correlation_id uuid`, `state quarantine_attempt_state`, `failure_code text?`, `field_path text?`, `sanitized_summary text?`, `canonical_change_count int?`, `started_at ts`, `finished_at ts?`, `created_at ts` | Append-only terminal outcome; partial UK one running attempt/quarantine; nonnegative change count |
| `retention_executions` | `id uuid PK`, `policy_key text`, `state retention_state`, `cutoff_at ts`, `batch_size int`, `selected_count int=0`, `expired_count int=0`, `already_expired_count int=0`, `failed_count int=0`, `remaining_count int=0`, `failure_code text?`, `sanitized_summary text?`, `started_at ts`, `finished_at ts?`, `created_at ts` | Counts/batch nonnegative; terminal consistency; index started/state |
| `local_audit_events` | `sequence bigint identity PK`, `command_id uuid? FK`, `actor_operator_id uuid? soft`, `correlation_id uuid`, `action text`, `target_type text`, `target_id text`, `outcome audit_outcome`, `details jsonb={}`, `occurred_at ts`, `created_at ts` | Append-only; bounded allowlisted details; no credential, raw cursor, candidate, evidence, or DB error |
| `provider_activity_outbox` | `id uuid PK`, `event_digest char(64)`, `event_type text`, `severity severity`, `dedupe_key text`, `recovery_key text`, `local_run_id uuid? FK`, `local_quarantine_id uuid? FK`, `title text`, `summary text`, `evidence jsonb={}`, `event_at ts`, `delivery_state activity_delivery_state=pending`, `delivery_attempt_count int=0`, `last_delivery_attempt_at ts?`, `delivered_at ts?`, `last_failure_code text?`, `created_at ts`, `updated_at ts` | Event identity and safe payload are immutable; only delivery fields mutate; nonnegative attempts; pending/delivered timestamp checks; same ID/digest relays idempotently; no credential, raw cursor, candidate, or protected evidence |

The owning transaction emits an outbox event for every runtime transition, command terminal outcome, run terminal outcome, quarantine open/resolve/expire, retention failure/recovery, and publication complete/failure transition. Direct central reachability probes create central-origin activity instead of attempting a provider-local write.

Quarantine retry consumes the stored provider-neutral `normalized_candidate`; it never refetches or remaps source data. A successful retry atomically writes the exact canonical tables above, its promotion changes, attempt outcome, quarantine resolution, and local audit without changing the original run/page counters or source cursor.

### Provider `packscout_<provider_key>`: correlation and release publication

| Table | Required columns | Keys and invariants |
|---|---|---|
| `provider_change_consumers` | `consumer_key text PK`, `last_confirmed_sequence bigint=0`, `confirmation_kind text?`, `confirmation_id text?`, `lease_owner text?`, `lease_fence bigint=0`, `lease_expires_at ts?`, `row_version bigint=1`, `created_at ts`, `updated_at ts` | Allowed keys `catalog_correlation` and `provider_release`; monotonic sequence/fence; nonzero confirmation requires durable evidence; provider-release checkpoint advances only after an exact completion receipt |
| `provider_releases` | `id uuid PK`, `predecessor_id uuid? FK`, `provider_id uuid soft`, `provider_key text`, `public_provider_id uuid`, `through_change_sequence bigint`, `catalog_version_id uuid soft`, `catalog_content_hash char(64)`, `central_schema_version text`, `correlation_event_sequence bigint soft`, `correlation_snapshot_hash char(64)`, `public_profile_version_id uuid soft`, `public_profile_hash char(64)`, `provider_schema_version text`, `public_schema_version text`, `lifecycle artifact_lifecycle`, `category_count int`, `repack_count int`, `collectible_reference_count int`, `chase_count int`, `retired_repack_count int`, `batch_count int`, `content_hash char(64)`, `index_hash char(64)`, `data_as_of ts`, `last_successful_observation_at ts`, `stale_at ts`, `freshness text`, `created_at ts`, `assembled_at ts?`, `completed_at ts?` | Provider identity matches `database_identity` and deterministic public ID; immutable descriptor/batches after `assembled`; partial UK on complete input/content hashes reuses unchanged output; pinned hashes bind central catalog, temporal correlations, and public profile; nonnegative counts and lifecycle/time/hash checks |
| `provider_release_batches` | `id uuid PK`, `provider_release_id uuid FK`, `batch_kind text`, `batch_index int`, `payload jsonb`, `record_count int`, `byte_count int`, `body_hash char(64)`, `created_at ts` | Kind allowlist provider, category, repack, chase, retired-repack, search-index; UK `(provider_release_id,batch_kind,batch_index)`; append-only until assembly; bounded canonical payload/count/bytes |
| `provider_publication_operations` | `id uuid PK`, `provider_release_id uuid FK`, `operation_kind text`, `batch_index int?`, `idempotency_key text`, `request_digest char(64)`, `request_bytes bytea`, `body_hash char(64)?`, `lease_fence bigint`, `state publication_operation_state`, `attempt_count int=0`, `last_attempted_at ts?`, `failure_code text?`, `requested_at ts`, `completed_at ts?` | UK `idempotency_key`; bounded exact canonical bytes; changed bytes under one key conflict; identity/request immutable; controlled one-way delivery state; intent precedes network call and stale fence cannot terminalize |
| `provider_publication_receipts` | `id uuid PK`, `operation_id uuid UK FK`, `provider_release_id uuid FK`, `remote_receipt_id text UK`, `outcome publication_receipt_outcome`, `response_digest char(64)`, `response_bytes bytea`, `accepted_content_hash char(64)?`, `accepted_record_count int?`, `received_at ts`, `created_at ts` | Append-only; bounded sanitized bytes; accepted fields match the exact request/release; rejected receipt cannot advance lifecycle or checkpoint |
| `provider_publication_state` | `singleton_key boolean PK=true`, `completed_release_id uuid? FK`, `completed_through_change_sequence bigint=0`, `completion_receipt_id uuid? FK`, `completed_at ts?`, `observed_active_manifest_id text? soft`, `last_reconciled_at ts?`, `row_version bigint=1`, `updated_at ts` | Completion fields are all null/zero or all present; completed head and sequence advance monotonically from an accepted receipt; active manifest is an observation, not local activation authority |

Release construction first loads one complete central catalog/profile descriptor plus every required correlation as of `correlation_event_sequence`, canonicalizes that immutable mapping bundle, and records its hashes. It then opens the provider `REPEATABLE READ` transaction, captures the visible promotion boundary, and persists the descriptor and complete batches before commit. No provider transaction reads central tables, and later provider or central mutations cannot change the assembled release.

#### Canonical byte contract

1. Move the inspected recursive key-sorting serializer from `convex/dataReleaseCanonicalHash.ts` into a shared server-safe contract used by the assembler, publisher, and Convex validator.
2. Preserve array order, encode exact decimals as normalized base-10 strings, reject non-finite/unsupported values, and hash UTF-8 bytes with versioned SHA-256 domains for catalog, provider release, index, and request bodies.
3. Sort entities by artifact kind then stable public ID; sort relationships by their complete stable key; never use database row order.
4. Fill batches greedily in that order against versioned count and byte limits, recording the batch index, exact canonical byte count, and body hash.
5. Compute release content/index hashes from the descriptor and ordered batch-hash list, and persist exact outgoing request bytes so retry and receipt reconciliation cannot reserialize different bytes.

### Relationship and constraint enforcement

#### Same-database foreign keys

1. Central organization rows own providers, memberships, sessions through membership, audits, and alerts.
2. Central providers own config, credential, node, test, health, activity, alert, correlation, and manifest-operation rows.
3. Provider categories classify packs and collectibles; collectibles own instances; pack contents join packs to collectibles and optional exact instances.
4. Provider pulls belong to packs and contain one or more ordered items; market events point directly to resolved local subjects and optional account parties.
5. Catalog aliases, temporal correlations, version batches, release batches, operations, and local histories use only same-authority FKs.

#### Cross-database soft references

| Source | Target | Required reconciliation |
|---|---|---|
| Provider `database_identity` and `provider_runtime` | Central `providers` | Match provider UUID, immutable key, database name, schema version, and active topology before use |
| Central correlations | Provider categories/collectibles | Validate provider ID, local UUID, local row version, type, and retained change sequence |
| Central activity/alerts | Provider runs/quarantines | Carry provider ID with the local ID; unreachable or retained-away targets remain explicit soft-reference states |
| Provider releases | Central catalog versions/correlations/profile | Require complete catalog/profile descriptors, their hashes, one pinned catalog-ledger correlation boundary, and valid mappings for every public reference |
| Central manifest operation | Provider release and Convex manifest | Validate complete release, catalog compatibility, expected predecessor, digest, and exact receipt |

### Explicitly forbidden tables and columns

- No `canonical_entities`, `canonical_revisions`, `canonical_relationships`, or generic polymorphic relationship graph.
- No `streams`, `stream_controls`, `stream_runs`, `stream_id`, per-kind schedule, per-kind cursor, or per-kind worker state.
- No `product_config`, product normalization, global pack identity, estimated-EV recomputation queue, or Heat table.
- No source-record, raw-page payload, mapper, provenance, replay archive, or provider-adapter staging table in this feature.
- No central desired runtime state or offline command queue; provider runtime and commands are local authority.

### Convex target schema

The Convex model is a derived read database, not another canonical warehouse. Documents remain bounded and every unbounded child collection stays in its own table.

#### Catalog and provider artifacts

| Table | Ownership and key indexes |
|---|---|
| `catalogVersions` | Immutable catalog descriptor; unique public catalog version ID and content hash |
| `catalogCategories` | Catalog-version-scoped category; indexes by version/public ID, version/key, and version/parent |
| `catalogCollectibles` | Catalog-version-scoped collectible; indexes by version/public ID and normalized name; bounded search index |
| `catalogAliases` | Catalog-version-scoped retired-to-surviving public collectible mapping; unique alias per version |
| `providerReleases` | Immutable provider descriptor bound to one provider, one catalog version, one public-profile version, and the release hashes; indexes by public release ID/provider |

#### Public rows and manifest

| Table | Ownership and key indexes |
|---|---|
| `publicProviders` | Provider-release-scoped public provider/vendor presentation |
| `publicRepacks` | Provider-release-scoped repacks; unique `(providerReleaseId,publicRepackId)` |
| `publicRepackChases` | Provider-release-scoped pack/collectible relationship using global public collectible IDs |
| `providerSearchShards` | Provider-release-scoped bounded source rows used to build the manifest search index; count/byte/hash verified |
| `manifestRevisions` | Immutable predecessor, schema, fingerprint, activation timestamps, and the full current `DataReleaseMetadata` aggregate: public release ID, source watermark, content/config/origin/search hashes and versions, confidence-policy version, freshness timestamps/state, delayed-provider count, and reconciled vendor/category/repack/collectible/chase counts |

#### Manifest entries and durable state

| Table | Ownership and key indexes |
|---|---|
| `manifestEntries` | One row per manifest/provider selecting one complete provider release and its compatible complete catalog version; UK `(manifestId,providerId)` |
| `manifestCatalogLookups` | Manifest-scoped union mapping each category, collectible, and alias ID to one selected catalog document; duplicate IDs across entry versions must have identical canonical bytes and alias targets |
| `manifestRepackLookups` | Manifest-scoped unique public repack ID to selected provider release mapping for detail and saved-item membership checks |
| `manifestSearchShards` | Manifest-scoped globally sorted/faceted repack index with bounded shards, total counts, and one reconciled search hash |
| `activeManifestState` | Singleton active and previous manifest pointers plus latest accepted receipt |
| `publicationOperations` | Server-only idempotency, digest, status, and receipt evidence for catalog, provider, and manifest operations |
| `savedRepacks` | Existing verified owner token plus globally unique stable public repack ID; never release-scoped and does not retain obsolete release artifacts |
| `savedCollectibles` | Existing verified owner token plus stable global collectible ID; aliases resolve on read without rewriting the save, and the save does not retain obsolete catalog artifacts |

Heat tables are absent from this target slice. Existing public APIs return a stable unavailable Heat wrapper until a separately approved Heat design is implemented.

### Deterministic public IDs

| Public ID | UUIDv5 name input |
|---|---|
| Provider | `provider:<central_provider_id>` |
| Repack | `provider:<central_provider_id>:pack:<provider_local_pack_id>` |
| Global category | `global-category:<global_category_id>` |
| Global collectible | The `global_collectibles.id` UUIDv5 itself |

The namespace UUID and exact UTF-8 name format are versioned shared constants. IDs never include mutable display names, database locations, or release IDs.

## Interfaces, APIs, and Endpoints

### Database interfaces

| Interface | Contract |
|---|---|
| Central lifecycle | Starts one verified `packscout` client and exposes only central repositories |
| Provider locator | Accepts validated organization/provider identity and returns a bounded target descriptor or sanitized unavailable result |
| Provider lifecycle | Starts one role-verified provider client and exposes canonical/runtime repositories for that provider only |
| Canonical writer | Returns entity ID, resulting row version, material-change flag, and allocated promotion sequence or range; immutable replay returns the existing fact |
| Activity relay | Reads pending provider-local outbox rows, inserts the same event UUID/digest centrally, then marks only that local row delivered; central failure never rolls back provider work |
| Publication store | Persists immutable version/release batches, pinned correlation boundary, operation intent, digest, exact receipt, and monotonic checkpoint without a cross-system transaction |

### Admin HTTP compatibility

Existing login, operator, provider, operation, run, quarantine, alert, health, and Data Feed Lab route families remain. HTTP adapters authenticate, authorize, validate, then call central or provider services. Provider-local routes always include a validated `providerId`; a missing provider context never scans provider databases.

The Data Feed Lab adds no table and does not write a run, cursor, quarantine, canonical row, promotion change, audit payload, or raw response to persistence.

### Public projection mapping

| Source | Convex projection |
|---|---|
| Central `provider_public_profile_versions` | `publicProviders` presentation, URL allowlists, referrals, and promo fields pinned into each provider release |
| Central catalog version | `catalogCategories`, `catalogCollectibles`, and `catalogAliases` |
| Provider `packs` | `publicRepacks` with deterministic public repack ID |
| Provider `pack_contents` plus correlations | `publicRepackChases` using global collectible IDs |
| Provider economics/freshness | Allowlisted repack price, EV, buyback, odds, availability, content summary, and freshness fields |

Exact instances, provider accounts, pulls, market events, credentials, database topology, runtime, runs, commands, quarantine, evidence, audit, and internal publication state never enter public Convex documents.

Release mapping preserves the current DTO rules: provider `available` maps to public `active`, `sold_out` maps directly, and `unavailable` or retired packs become release tombstones rather than invalid public availability values. Token-address source currency remains canonical but projects as `CURRENCY_UNSUPPORTED` unless a supported fiat conversion is pinned. Exact decimal-to-minor-unit and rate-to-basis-point conversion uses the versioned currency exponent and deterministic half-up rounding, never JavaScript floating point. Public top chase comes from the one active `top_chase`; evidence, confidence, observed time, display order, unavailable reasons, and freshness map from the typed columns above.

Every list, search, facet, and cursor query reads `manifestSearchShards`; detail and saved-repack membership use `manifestRepackLookups`; collectible lookup and aliases use `manifestCatalogLookups`. Cursors carry the active manifest fingerprint and stable sort tuple, so a cross-manifest continuation returns the existing structured invalid-cursor result. All public responses return the aggregate metadata stored on `manifestRevisions`.

For metadata parity, `publicReleaseId` is the manifest ID and `publicConfigRevision` is its monotonic generation. Source watermark, public-config hash, origin-set hash, content hash, and search-index hash are domain-separated hashes of sorted selected-entry descriptors and reconciled manifest artifacts. `dataAsOf`, last-successful-observation, and stale deadline use the conservative minimum across selected providers; freshness is delayed when any selected provider is delayed, and counts come from the validated manifest union rather than summing duplicate global identities.

## Data Flow

1. A provider-neutral mixed page validates provider identity, config version, worker fence, cursor, digest, and record bounds before opening one provider transaction.
2. That transaction writes only the contracted canonical/fact/quarantine/page/run tables, advances the one cursor, allocates commit-ordered promotion sequences, and appends safe local activity-outbox events atomically.
3. The correlator consumes provider changes independently, writes deterministic central identities/correlations/events/changes through the commit-ordered catalog ledger, then confirms only the consumed provider sequence; a separate relay copies outbox rows idempotently to central activity without blocking provider commits.
4. Catalog and provider builders persist immutable batches from stable local boundaries; publishers reconcile exact Convex receipts before advancing checkpoints.
5. A one-provider manifest compare-and-swap selects its complete release/catalog pair, preserves unrelated entries byte-for-byte, validates overlapping catalog bytes/aliases, and materializes reconciled metadata plus manifest lookup/search indexes; saved logical IDs remain outside artifact lifecycle.

## Error Handling and Edge Cases

| Case | Required handling |
|---|---|
| Wrong database role, provider, key, or schema | Fail readiness closed with a sanitized provider-specific code; do not expose a client |
| Cross-database target missing or stale | Preserve the local commit, record bounded reconciliation evidence, and retry from the last confirmed sequence |
| Duplicate page, fact, activity event, change, or publication operation | Same identity plus same digest returns the prior outcome; changed digest is an immutable conflict |
| Category/alias cycle, instance mismatch, empty pull, unresolved market subject, or invalid money pair | Reject the local transaction with no cursor, checkpoint, or partial canonical effect |
| Provider, central, or Convex outage | Preserve healthy providers and prior active public state; apply bounded provider-specific timeout/backpressure |

Raw database, upstream, credential, cursor, candidate, and protected-evidence content becomes a stable sanitized error before it crosses its owning server boundary.

## Testing and Verification

### Schema and migration verification

- Generate and validate both Prisma schemas and compare them with independent central/provider parity manifests.
- Deploy central and provider migrations to empty PostgreSQL 16+ databases, repeat deployment as a no-op, and reject the wrong role or provider identity.
- Assert every PK, FK, soft-reference column, UK, partial index, check, trigger, append-only permission, and delete restriction described here.
- Assert forbidden legacy, stream, product-normalization, raw-staging, and Heat tables are absent.
- Run two provider database schemas on independently addressable PostgreSQL instances in integration tests.

### Invariant verification

- Property-test category and alias acyclicity, deterministic UUIDv5 IDs, correlation replay, provisional stability, and temporal active-row uniqueness.
- Transaction-test commit-ordered ledger allocation under concurrent writers, canonical mutation plus promotion change, mixed-page cursor movement, immutable replay, quarantine retry, and stale worker fences.
- Verify exact numeric round trips and deterministic minor-unit conversion without JavaScript floating-point coercion or null-to-zero substitution.
- Verify one active provider run, one running quarantine attempt per record, independent consumer checkpoints, and receipt-gated checkpoint advancement.
- Verify row-version no-ops, retirement, append-only facts, and restricted deletion under the real application roles.

### Compatibility and volume verification

- Run current admin auth/operator/provider/run/quarantine/alert contract suites against one central and two provider databases.
- Run current public list, detail, search, desired-collectible, cursor, unavailable-value, alias, and saved-item fixtures against the new Convex manifest model.
- Load at least the supplied 203,091-record sample distribution and record query plans for run history, pulls by pack/time, events by subject/time, promotion backlog, and cross-provider admin merge reads.
- Prove one provider or central outage leaves healthy provider runs/publication successful, and that pending local activity relays once after recovery.
- Run `npm run verify:framework` only after focused database, admin, service, worker, contract, and Convex suites pass.

## Open Questions and Risks

### Product confirmation

1. **Runner restart during central outage.** Recommended: an already-running process may finish or start locally authorized work using unexpired cached config and credentials already held in memory; a restarted process must wait for central credential access because credential material is never persisted in a provider database.

### Plan corrections and scale risk

1. **Configuration task drift.** Task 003 still mentions approval state even though the approved current-compatible flow is immutable revision → exact connection test → activation. This spec intentionally has no approval column or workflow.
2. **Dependency drift.** Provider release assembly requires a complete catalog version, so task 013 must depend on task 012 before builders execute it.
3. **Manifest operation drift.** Task 015 lists `clear`, but the approved simple operation set is advance/add/remove/rollback. The task must define a distinct required meaning or remove `clear`; this spec does not create a duplicate synonym for remove.
4. **Historical artifact drift.** The current HTML ERD still shows `platform`, a separate catalog database, and streams. Task 019 must render this contract rather than treating the historical diagram as implementation authority.
5. **Artifact volume.** Provider-local JSONB batches are the simplest initial durable store. Focused volume tests must set the bound; exceeding it requires an approved switch to immutable object bytes plus stored URI/hash, not unbounded JSONB.

## Handoff Notes

1. Resolve the runner-restart confirmation under Open Questions before marking this spec final or executing schema work.
2. Amend source tasks 003, 012–013, and 015 to match the confirmed publication/configuration contract; do not encode corrections as compatibility code.
3. Implement central identity/access tables first, then the provider template and provider gateway, then the global catalog and publication tables.
4. Keep every migration role-specific and reversible by replacement of a disposable pre-launch database, not by destructive mutation of `packscout_dev`.
5. Update the Markdown data dictionary and interactive ERD from the verified schemas only after parity tests pass.
