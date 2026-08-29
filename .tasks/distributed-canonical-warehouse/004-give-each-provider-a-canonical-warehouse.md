# Task: Give Each Provider a Canonical Warehouse

**ID:** distributed-canonical-warehouse/004
**Depends on:** distributed-canonical-warehouse/001
**Blocks:** distributed-canonical-warehouse/005, distributed-canonical-warehouse/006
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including schema invariants, canonical write behavior, and representative data verification
**Status:** not started

## Start Here

Turn the approved provider ERD into an invariant checklist for categories, packs, collectibles, instances, contents, accounts, pulls, pull items, market events, and promotion changes before defining persistence behavior.

## Objective

Give every provider an isolated, typed, and understandable canonical warehouse for its repacks, collectibles, pulls, and market activity, with durable entity-update tracking for later publication.

## Context

The legacy generic canonical entity, revision, and relationship graph is intentionally left behind. Every `packscout_<provider_key>` database has the same provider schema but owns only that provider's data. Provider-local keys are unique only within that database. Global identity correlations are central soft references and never weaken local relational integrity.

The canonical core contains resolved product and transaction facts. Pending pulls, unrevealed outcomes, unresolved subjects, raw source payloads, source record mappings, and provenance remain outside this feature's source-population boundary.

## Requirements

### Catalog entities

- Store `CATEGORIES` as a tree with a stable local key, nullable parent, display name, timestamps, and row version; reject self-parenting and cycles.
- Store `PACKS` with stable local identity, category, family, display name, availability, bounded content-evidence state, nullable non-negative total and remaining inventory, exact price and currency, buyback terms, odds evidence, public EV fields, bounded attributes, timestamps, and row version.
- Store `COLLECTIBLES` with stable local identity, category, type such as card, watch, art, or another bounded type, display identity, attributes, timestamps, and row version.
- Store exact `COLLECTIBLE_INSTANCES` separately from collectible identity; instance certification or provider keys are not assumed globally unique.
- Store `PACK_CONTENTS` as the many-to-many pack and collectible relationship with an optional exact instance, nullable non-negative total and available quantity, role, bounded probability, stated value, currency, timestamps, and row version.

### Pull and market facts

- Store stable `PROVIDER_ACCOUNTS` keyed by provider account identity rather than mutable display names.
- Store one immutable `PULL` with stable local key, one pack, optional provider account, occurrence time, and nullable exact paid amount and currency; every completed pull has at least one ordered `PULL_ITEM`.
- Give each pull item positive quantity, collectible, optional exact instance, and nullable exact stated value and currency; the instance must belong to the referenced collectible.
- Store immutable `MARKET_EVENTS` for `sale`, `buyback`, `mint`, `burn`, `transfer`, `list`, `unlist`, `swap`, `ship`, and `other`, with occurrence time, nullable exact amount and currency, at least one resolved local pack, collectible, or instance subject, and bounded provider-account parties.
- Use a nullable deterministic `event_group_id` to group atomic rows from one compound transaction without collapsing their individual amounts or directions.

### Value and history rules

- Represent money, probability, and percentage values as exact bounded decimals with explicit currency where money is present; never use floating-point storage.
- Preserve unavailable or unknown economics as explicit nullable or status-bearing values rather than numeric zero.
- Keep pulls, pull items, and market events append-only; ordinary operations cannot rewrite history, and source-specific correction behavior remains outside this feature.
- Use restricted deletion and retirement semantics so packs or collectibles referenced by history are not hard-deleted.
- Keep exact instances, provider accounts, pull history, and market-event history outside the Convex public projection.

### Change tracking

- Give every mutable entity `created_at`, `updated_at`, and monotonic `row_version` values that change only on a material update.
- Store append-only `PROMOTION_CHANGES` with a provider-local sequence, entity type, entity ID, entity version, `upsert | retire` operation, and change time for every canonical insert, material update, immutable-fact insertion, and retirement covered by the provider change contract.
- Commit the canonical mutation or immutable-fact insertion and its promotion-change row in the same provider transaction.
- Avoid a promotion-change row for a byte-for-byte or semantically unchanged write.
- Retain change rows after publication so checkpoint and receipt reconciliation remains auditable.

## User-Facing Behavior

There is no direct new screen in this task. Later admin and frontend tasks receive typed, predictable data: packs can contain many collectibles, pulls can yield multiple items, and missing values appear as unavailable rather than misleading zeroes.

## Interface Contract

A canonical write returns the current entity ID, resulting row version, material-change flag, and provider-local promotion sequence when a material change occurred. Immutable facts return their stable ID and indicate whether an idempotent replay reused the existing fact.

Consumers address local entities only through a validated provider database context. Cross-database catalog correlation consumes `providerId`, local entity ID, local entity version, and bounded identity evidence; it never receives an open provider database transaction.

## Acceptance Criteria

### Model acceptance

- [ ] The provider schema represents category trees, multi-collectible packs, exact instances, provider accounts, multi-item pulls, and every approved market-event type.
- [ ] Category cycles, cross-collectible instance references, empty completed pulls, and unresolved market-event subjects are rejected.
- [ ] Exact decimals and unavailable states round-trip without floating-point loss or zero substitution.
- [ ] Immutable pull and market history cannot be updated or deleted through ordinary canonical operations.
- [ ] Exact instances, accounts, pulls, events, and protected attributes are absent from public projection fixtures.

### Change acceptance

- [ ] A material mutable-entity update increments `row_version` and atomically appends one promotion change.
- [ ] An unchanged replay creates neither a new entity version nor a promotion change.
- [ ] Retirement preserves referenced history and emits a retire change for the next release.
- [ ] A forced transaction failure leaves neither a partial canonical mutation nor an orphan promotion change.
- [ ] The same provider schema and invariants pass against two separately provisioned provider databases.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- The typed provider schema replaces the generic canonical graph and contains no compatibility fallback.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
