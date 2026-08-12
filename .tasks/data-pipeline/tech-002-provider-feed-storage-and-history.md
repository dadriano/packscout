# Technical Spec: Provider Feed, Storage, and History

**Spec ID:** tech-002  
**Related tasks:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md)  
**Depends on tech specs:** [tech-001](tech-001-runtime-security-and-service-boundaries.md)  
**Spec status:** draft

## Purpose

Define the common cursor-feed contract and durable persistence model that make provider imports replayable, auditable, idempotent, tenant-scoped, and independent from any one platform's payload shape.

## Current System Context

- PackScout uses PostgreSQL with Prisma ORM, Prisma Client, and Prisma Migrate for its persistence boundary.
- The eight supplied JSON samples all contain `catalog`, `pulls`, and `sales` arrays.
- Each outer record has PackScout metadata, while provider-specific fields remain nested in `data`.
- Sales are absent in the GameStop, Stadium Vault, and Trove samples, and nullable values occur in otherwise valid records.
- The standalone `scripts/fetch-gacha-top-cards.mjs` is a focused Collector Crypt helper, not a reusable ingestion runtime.

## Proposed Implementation

### Persistence choice

Use PostgreSQL 16 or newer with Prisma ORM, Prisma Client, and Prisma Migrate. The Prisma schema is the application data model and checked-in Prisma migration SQL is the database history. PostgreSQL supplies transactional page commits, JSONB raw evidence, partial uniqueness, row-level locking, keyset pagination, and durable worker coordination without introducing a second queueing datastore.

Use generated Prisma Client for tenant-scoped CRUD, relations, keyset reads, bounded batches, and interactive transactions. Keep PostgreSQL-native locks and set-based operations behind organization-scoped repositories, using parameterized `Prisma.sql` with `$queryRaw` or `$executeRaw` only where Prisma Client cannot express the required atomic or bounded behavior. Never use the unsafe raw APIs with dynamic or untrusted input.

Create reviewed Prisma migration SQL for database invariants the Prisma schema cannot express directly, including check constraints and partial indexes. Migration-from-empty and integration tests must prove those invariants; `db push` is not a deployment workflow.

### Feed contract

Define a versioned `ProviderFeedPageV1` runtime schema in `packages/contracts`:

```ts
interface ProviderFeedPageV1 {
  catalog: CatalogEnvelopeV1[];
  pulls: PullEnvelopeV1[];
  sales: SaleEnvelopeV1[];
  next_cursor: string | null;
  has_more: boolean;
}
```

The HTTP cursor adapter sends `GET <endpoint>?platform=<platform>&cursor=<cursor>` and omits `cursor` for the first page. It supports `none` or bearer authentication, a bounded response body, a configurable timeout, and response validation before persistence.

### Envelope rules

Every record requires `platform`, `external_id`, `collected_at`, and a JSON object in `data`. Catalog records require `updated_at`; pull records require `occurred_at` and nullable `pack_external_id`; sale records require `event_type`, nullable amount/currency/transaction hash, and `occurred_at`.

The outer platform must match the configured platform. Identifiers and cursors are opaque strings. Timestamps must parse as ISO-8601 instants and are stored normalized to UTC without replacing the raw payload.

### Versioned provider configuration

Store immutable configuration revisions and a small mutable provider aggregate. Only one provider may be active for a platform in an organization.

Draft revisions can be edited through replacement revisions. A revision must pass a connection test before activation. Activation atomically selects the tested revision, archives the prior active revision, records the actor, and schedules the next due run.

### Raw evidence and deduplication

Persist the full validated page before advancing a cursor. Hash the canonical serialized outer record and use `(organization_id, provider_id, record_kind, external_id, source_updated_or_occurred_at, content_hash)` as the immutable source-record identity.

A repeated record links to its existing source record and does not create duplicate canonical history. A changed record with the same external identity creates a new source record and may produce a new canonical revision.

## Code Changes

### Contracts and adapter boundary

- Add Zod schemas and inferred DTO types under `packages/contracts/src/provider-feed.ts`.
- Add `ProviderAdapter`, `ProviderPage`, `ProviderRequestContext`, and normalized adapter failure types under `packages/services`.
- Implement a generic `http-cursor-v1` adapter under `apps/worker/src/adapters/http-cursor-v1.ts`.
- Add a registry keyed by stored adapter identifier; configuration must never accept a module path or executable code.

### Database ownership

- Add Prisma models for organizations, providers, configurations, secrets, runs, pages, raw records, and quarantine under `packages/database/prisma/schema.prisma`.
- Keep Prisma migrations append-only after merge, preserving reviewed PostgreSQL-only constraints and indexes, and expose environment-specific migration commands.
- Add repository methods that always require `organizationId`, use generated Prisma Client by default, and use interactive transactions for activation and page commit.
- Encapsulate approved parameterized raw SQL inside `packages/database`; callers do not issue ad hoc SQL.
- Add fixture builders from the eight sample files without copying sample payloads into production code.

## Database / Schema Changes

### Provider configuration

Create:

- `provider_sources(id, organization_id, platform_key, display_name, state, active_revision_id, next_run_at, created_at, updated_at)`.
- `provider_config_revisions(id, provider_id, version, adapter_key, endpoint_url, auth_mode, schedule_seconds, stale_after_seconds, tested_at, tested_by, created_by, created_at)`.
- `provider_secret_versions(id, provider_id, revision_id, ciphertext, nonce, auth_tag, key_version, created_at, retired_at)`.
- `provider_connection_tests(id, provider_id, revision_id, outcome, latency_ms, sanitized_code, tested_by, tested_at)`.

Use a unique index on `(organization_id, platform_key)` for the provider aggregate and `(provider_id, version)` for revisions. Enforce a minimum safe schedule interval and positive stale threshold in both contracts and database checks.

### Runs and raw pages

Create:

- `import_runs(id, organization_id, provider_id, config_revision_id, trigger, state, requested_cursor, final_cursor, started_at, finished_at, heartbeat_at, counters_json, failure_code, failure_summary)`.
- `import_pages(id, run_id, page_number, requested_cursor, next_cursor, has_more, payload_json, payload_hash, record_counts_json, committed_at, expires_at)`.
- `source_records(id, organization_id, provider_id, run_id, page_id, record_kind, external_id, source_time, collected_at, payload_json, content_hash, expires_at, created_at)`.
- `source_record_observations(source_record_id, run_id, page_id, observed_at)`.

Use unique constraints on `(run_id, page_number)`, `(run_id, requested_cursor)`, and the immutable source-record identity. Store cursor values as bounded text, never as numeric offsets.

### Quarantine

Create `quarantine_records(id, organization_id, provider_id, source_record_id, record_kind, external_id, state, reason_code, field_path, sanitized_summary, retry_count, last_retry_at, resolved_at, expires_at, created_at)` and `quarantine_attempts(id, quarantine_id, run_id, outcome, reason_code, attempted_by_actor_key, attempted_at)`.

Quarantine rows retain metadata after raw payload expiry. A retry after expiry returns a stable non-retryable result unless a newer source observation supplies fresh evidence.

## Interfaces, APIs, Endpoints

### Adapter interface

```ts
interface ProviderAdapter {
  testConnection(input: AdapterConnectionInput): Promise<ConnectionTestResult>;
  fetchPage(input: AdapterPageInput): Promise<ProviderFeedPageV1>;
}
```

Both operations receive an injected HTTP client, clock, timeout, decrypted credential handle, endpoint, platform, and cursor. They return normalized results and never write to the database.

### Provider service operations

- `createDraft`, `replaceDraft`, `testRevision`, `activateRevision`, and `disableProvider` use explicit actor context.
- `getActiveProviderByPlatform` returns one active tested configuration or a typed unavailable result.
- `commitPage` transactionally stores the page, source records, quarantine entries, projections, and run cursor.
- `expireRawEvidence` clears eligible raw JSON while retaining hashes, counts, provenance, and canonical history.

## Data Flow

1. A route or worker loads a provider through the organization-scoped provider service.
2. The adapter registry resolves the stored adapter key and the secret service returns an in-memory credential handle.
3. The adapter fetches and validates one page without persistence side effects.
4. The import service commits page evidence, valid records, quarantines, and projection changes in one database transaction.
5. Only after commit does the run's durable cursor move to `next_cursor`; `has_more=false` completes the feed walk.

## Error Handling and Edge Cases

- Invalid outer page shape fails the page and does not move the cursor; invalid individual records are quarantined when the page envelope remains trustworthy.
- A cursor cycle, unchanged cursor with `has_more=true`, excessive page count, or oversized response stops the run as incomplete with a stable safety code.
- A redirect to a disallowed host, private network destination, or non-HTTPS endpoint fails validation to reduce server-side request forgery risk.
- Nullable sales amount/currency and empty sales arrays are valid; missing required record identity or source time is not.
- Configuration activation loses an optimistic concurrency race with `409 CONFIG_REVISION_CONFLICT` and does not partially switch secrets.

## Testing and Verification

### Contract and adapter scenarios

- Parse all eight samples through fixture pages and prove empty arrays and declared nullable fields remain valid.
- Reject platform mismatches, invalid times, missing IDs, non-object data, malformed pagination, oversized responses, and cursor cycles.
- Test no-auth and bearer requests without logging authorization headers or decrypted credentials.
- Prove transient network and HTTP failures normalize to retryable codes while contract failures remain non-retryable.

### Persistence scenarios

- Replay identical pages and records without duplicate raw or canonical revisions.
- Commit changed content for the same external identity as new source history while keeping a single current projection.
- Roll back the entire page transaction when any persistence step fails before cursor advancement.
- Enforce organization scope, active-provider uniqueness, tested-before-active, and the 90-day raw-evidence policy.
- Run migration-from-empty and repository integration tests against PostgreSQL before `npm run verify:framework`.

## Open Questions and Risks

- Confirm the production database provider, backup policy, and availability target before migration implementation.
- Confirm the exact upstream response location for `next_cursor` and `has_more`; sample files contain record arrays but not pagination metadata.
- Define the endpoint hostname allowlist process for production provider configuration.
- Large raw JSONB pages can create storage pressure; enforce size and record-count limits before launch.

## Handoff Notes

Build the contract parser and database constraints before mapping provider payloads. Preserve raw evidence exactly as received, and keep provider-specific interpretation out of the generic adapter and storage repositories.
