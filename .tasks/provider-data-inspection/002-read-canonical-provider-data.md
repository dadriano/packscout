# Task: Read Canonical Provider Data from PostgreSQL

**ID:** provider-data-inspection/002
**Depends on:** none
**Blocks:** provider-data-inspection/003, provider-data-inspection/006, provider-data-inspection/008
**Estimated scope:** medium
**Status:** done

## Objective

The admin server can answer, for any configured provider, what canonical records PostgreSQL holds for it — how many of each kind, how fresh they are, which specific records exist, and what one record's current content is — through org-scoped, keyset-paginated reads that never expose provider credentials and never accept caller-supplied query text.

## Context

PostgreSQL is authoritative for PackScout's canonical data. The relevant shape:

- `provider_sources` is the provider roster: one row per provider per organization, uniquely keyed by organization plus `platform_key`, carrying a display name and a lifecycle state. `platform_key` is the stable provider identity used everywhere downstream, including in the product backend.
- `canonical_entities` is one row per canonical business object, identified by organization, `platform_key`, `record_kind`, and `external_id`, pointing at its `current_revision_id`.
- `canonical_revisions` is the append-only content history: `revision_number`, `content_json` with its `content_hash`, `provenance_json` with its `provenance_hash`, plus `source_updated_at`, `source_collected_at`, and `accepted_at`.
- `canonical_relationships` records edges declared from one entity toward another provider record, resolved or still dangling.
- `canonical_record_kind` enumerates the kinds: `platform`, `pack`, `catalog_asset`, `ev_input`, `pull`, `market_event`, `estimated_ev`.

The production baseline is roughly 14.5 million records across four providers, so anything that scans a whole table on every page load is not viable. Reads must stay responsive at that size, and any number that cannot be produced exactly at that size must be labelled as approximate rather than presented as a fact.

This task produces the read capability only. Task 003 puts a page on it; tasks 006 and 008 reuse it for parity and diffing.

## Requirements

- A provider roster read returning every configured provider for the caller's organization with its `platform_key`, display name, and state, ordered stably.
- A per-provider summary: for each canonical record kind, how many entities exist, plus the newest and oldest `source_collected_at` and `accepted_at` observed for that provider. Counts that cannot be produced exactly within the response budget at production scale must be returned as explicitly approximate, with the response saying so; a count must never be silently estimated and presented as exact.
- A keyset-paginated entity listing for one provider, filtered by record kind, with an optional exact `external_id` lookup and an optional prefix match on `external_id`. Ordering is deterministic and total, page size is bounded server-side, and cursors are opaque to the caller.
- A single-entity read returning the entity's identity, its current revision's `revision_number`, `content_json`, `content_hash`, `provenance_hash`, the three timestamps, and the relationship edges declared from it with their resolution state.
- Every read is scoped to the caller's organization. A caller cannot reach another organization's rows by supplying an identifier, and the scoping is enforced in the query, not by filtering results after the fact.
- Filters, sort keys, and page sizes come from a fixed enumerated set. No endpoint accepts SQL, a filter expression, a sort expression, or a column name from the caller.
- Provenance is returned as a summary — the originating source record, import run, and mapper or adapter identity — and is stripped of anything credential-shaped: bearer tokens, API keys, authorization headers, connection strings, and raw upstream request headers never leave the server, in any field, at any nesting depth.
- Distinct, structured failures for: unknown provider, unknown entity, record kind not valid for the request, malformed cursor, and database unreachable. A database failure must not surface a driver message or a query fragment to the caller.

## User-Facing Behavior

None directly — this is the read capability behind task 003's page.

## Interface Contract

- Consumers are task 003 (the browse page), task 006 (canonical-side counts and freshness for the parity summary), and task 008 (the canonical record content that gets projected and diffed). All three read through this capability rather than issuing their own queries.
- The roster read is the source of the provider list used across the whole feature, keyed by `platform_key`. Task 004's published-side reads are keyed by the same value, and task 006 joins the two sides on it.
- The entity listing exposes both the internal entity identifier and the `(platform_key, record_kind, external_id)` natural key, because task 008 needs the natural key to find a record's published counterpart.
- The single-entity read returns the current revision's content unmodified apart from redaction, so task 008 can project it through the public projection without re-fetching.

## Acceptance Criteria

- [x] The roster, summary, listing, and single-entity reads all return correct results for a seeded provider and are scoped to the caller's organization.
- [x] Paging forward through a listing with a cursor visits every entity exactly once under a deterministic order, and a malformed cursor is rejected with a structured error rather than silently restarting from the beginning.
- [x] A count returned as approximate is labelled approximate in the response; an exact count is labelled exact.
- [x] Credential-shaped values anywhere in provenance are redacted before the response leaves the server, including when nested.
- [x] Unknown provider, unknown entity, invalid record kind, malformed cursor, and database-unreachable each produce their own structured error, and none carries a driver message or query text.
- [x] No endpoint accepts a SQL fragment, filter expression, sort expression, or column name from the caller.

## Verification

Targeted tests prove keyset pagination visits every row exactly once and rejects malformed cursors, that organization scoping holds when a foreign identifier is supplied, that the redaction rule strips credential-shaped values at depth, and that each failure maps to its own structured error. The services and admin test suites plus the workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented as specified. Roster, per-kind summary, keyset listing, and single-entity read are org-scoped in the query itself; filters are enumerated; page size is bounded server-side; provenance is summarized and redacted; each failure maps to its own stable code carrying no driver text.
- Count precision: counting runs over a bounded subquery capped at 50,000 index entries. A bucket inside the bound reports `exact`; one past it reports `at_least` with the bound as a floor. A floor is returned rather than a planner estimate because a floor is a true statement about the data and an estimate is not.
- Divergences: added a migration and a supporting index (`canonical_entities_inspection_recency_idx`). Per-kind oldest/newest could not be answered from the existing indexes without a sequential scan over a provider's whole history; the new index turns it into two lookups. The index is built in-transaction like every other migration in this repository, with the production out-of-band `CREATE INDEX CONCURRENTLY` path documented in the migration itself — this repository has no precedent for concurrent index builds in Prisma migrations and Prisma wraps each migration in a transaction.
- Vocabulary correction: the canonical record kind is `market_event`, not `sale`. The task text was written against an older branch and has been corrected here and in tasks 003, 006, 007, and the feature index.
- Verification: `npm run test --workspace=@packscout/services` (793 pass), `npm run test:admin` (369 pass), `npm run check:prisma` (schema parity, lifecycle, and setup all pass, including the new index recorded in the parity manifest), `npm run typecheck` (0 errors), `npm run lint` (clean), `npm run scan:framework-standards:ratchet` (0 new findings).
