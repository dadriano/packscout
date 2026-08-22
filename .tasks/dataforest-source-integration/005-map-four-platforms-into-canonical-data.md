# Task: Map Four Platforms Into Canonical Data

**ID:** dataforest-source-integration/005
**Depends on:** dataforest-source-integration/002
**Blocks:** dataforest-source-integration/006, dataforest-source-integration/009
**Estimated scope:** large
**Estimated effort:** 4–5 days for one builder, including four mapper contracts, canonical migration, EV inputs, and focused verification
**Status:** done

## Start Here

Map one sanitized normalized pack, card, pull, and trade fixture into canonical candidates, then prove the trade becomes a market event, the card remains a generic catalog asset with card type, and `available = false` becomes unavailable rather than sold out.

## Objective

Convert normalized provider observations for Courtyard, Collector Crypt, Phygitals, and ClutchPacks into source-independent PackScout history without coupling platform mapping to DataForrest or leaking provider-specific rules into generic ingestion.

## Context

Task 003 translates DataForrest's outer fields into task 002's normalized observation contract: replacement identity namespace, record-ID scope, provider record ID, platform, record kind, relationships, event type, currency, payment method, transaction evidence, and pack availability. The normalized observation also references protected provider-local display, pricing, imagery, odds, value, wording, and status evidence. Normalized facts are authoritative; native evidence cannot override them.

Catalog records may revise under stable identity. Pulls and market events are immutable. Existing PackScout EV input and recomputation behavior must continue when approved pack or card evidence changes.

Task 002 publishes the four contract-only mapper compatibility descriptors used during source activation. This task implements exactly those pinned keys and versions; it does not redefine activation metadata.

## Requirements

### Shared canonical rules

- Project catalog pack to canonical pack, catalog card to generic catalog asset with card type, source pull to canonical pull, and source trade to canonical market event.
- Keep organization, stable provider, canonical kind, and normalized provider record ID as identity only after verifying task 002's injective record-ID-scope-to-canonical-kind mapping; exclude scope, identity namespace, source adapter, source instance, connection, run, page, and collection timestamp from the key because canonical kind uniquely carries the scope.
- Preserve source `first_seen_at` and effective event time under deterministic revision ordering, including late older catalog observations.
- Create a catalog revision only when canonical content changes; exact or collection-only replay is duplicate, while changed pull or market-event content is an immutable conflict.
- Quarantine a stable source record that changes stream or pack/card discriminator inside its contract-frozen record-ID scope; permit the same raw ID in two separately evidenced scopes only because those scopes map to distinct canonical kinds.

### Event, money, and availability rules

- Preserve exact known event codes `sale`, `buyback`, `mint`, `burn`, `transfer`, `list`, `unlist`, `swap`, and `ship`; store a future nonblank code with a bounded warning and reject a blank code.
- Use the normalized provider record ID for identity and keep nullable transaction hash as evidence only.
- Preserve nullable amount, currency ticker, and `payment_method` as separate values without inventing zero or empty strings.
- Map pack `available` true to available, false to unavailable, and null to unknown; missing required availability is invalid.
- Accept sold out only from a separate authoritative canonical fact; provider disappearance, nested stock wording, or normalized false cannot infer it.

### Provider-local mapping

- Keep separate deterministic mappers for Courtyard, Collector Crypt, Phygitals, and ClutchPacks behind the shared mapper registry.
- Resolve each mapper only from its immutable mapper key and version after verifying provider, normalized-record contract, and identity namespace; never resolve a mapper from source type or transport adapter identity.
- Require a supported nonblank display name for pack catalog records; malformed optional description, category, price, image, odds, draw, provider-EV, and buyback fields are omitted with warnings.
- Permit card, pull, and market-event optional display facts to be absent while requiring their normalized identities and relationships.
- Preserve Phygitals `BUY` and Collector Crypt `unlisted` only as protected native wording while canonical output remains `buyback` and `unlist`.

### Mapper descriptor conformance

- Require every implementation registration to match task 002's exact provider, mapper key and version, normalized-contract version, and identity-namespace descriptor; missing or extra launch registrations fail closed.

### Provider availability evidence

- Use normalized availability for Courtyard and ClutchPacks disappearance and reappearance regardless of which compatible source adapter emitted it, even when provider-local evidence has no flag.
- Let task 003 prove DataForrest outer availability translates to that normalized fact; the mapper never reads a DataForrest field or source type.
- Keep adapter and native provenance on mapped outcomes without making either part of canonical business identity.
- Allow a future source adapter to reuse an existing platform mapper only when it emits the same normalized-record contract and identity namespace.
- Require a separately registered mapper version when normalized provider meaning changes; generic ingestion and scheduling remain unchanged.

### Relationships and EV

- Link pulls by scope-qualified normalized pack and card identities and market events by a scope-qualified card identity; validate each target scope's canonical kind and never substitute native-evidence identifiers for a missing required normalized key.
- Preserve unresolved relationship keys when catalog records have not arrived and reconcile them idempotently when dependencies appear.
- Emit EV-input candidates only from approved, complete odds, quantity, value, currency, and buyback evidence; incomplete evidence makes calculated EV unavailable rather than invalidating the pack.
- Keep provider-reported EV, EV-input evidence, PackScout-calculated EV, and market-event money as distinct meanings.
- Mark every mapped record as an inserted, revised, duplicate, or quarantined candidate with warnings and unresolved relationships counted separately.

### Registry boundary

- Register exactly four launch mapper keys and versions, pinned by the four DataForrest source revisions, without adding provider-name branches to scheduling, fetching, persistence, or public projection.
- Keep Beezie, GameStop, Trove, and Stadium Vault mapper code and focused tests compiling as dormant reference implementations.
- Prevent deferred mappers from production registration, activation, or configuration until each has an approved normalized source contract and source type.
- Reject a platform mismatch locally; never redirect the record to another provider mapper.
- Remove sale-as-canonical-kind assumptions while preserving `sale` as event data.

## User-Facing Behavior

None directly. Task 009 defines the availability contract, fixtures, and public UI readiness; the separate production publisher and finalizer remain an explicit live-publication prerequisite.

## Interface Contract

Each mapper accepts one versioned normalized provider observation for its exact provider, normalized-record contract, replacement identity namespace, record-ID scope, and pinned mapper version, then returns one of:

- a canonical pack, catalog asset, pull, or market-event candidate;
- a candidate plus bounded warnings or unresolved relationship keys;
- a quarantined outcome with a stable provider-local reason.

Pack and EV-input revisions identify the affected provider pack so task 006 can enqueue deduplicated EV recomputation atomically.

## Acceptance Criteria

### Canonical proof

- [x] Sanitized fixtures cover pack, card, pull, all observed trade shapes, all nine event codes, future codes, nullable money, and payment methods across the four providers.
- [x] Catalog revisions, exact replay, late observations, immutable conflicts, and identity-kind conflicts have deterministic outcomes.
- [x] Available, unavailable, unknown, reappeared, and separately authoritative sold-out states cannot masquerade as one another.
- [x] Out-of-order pack and card relationships reconcile without losing or duplicating provider events.

### Provider and EV proof

- [x] Phygitals native `BUY`, Collector Crypt native `unlisted`, and Courtyard or ClutchPacks disappearance retain the adapter-normalized meanings.
- [x] Complete EV evidence emits current EV-input candidates; incomplete evidence leaves EV unavailable without quarantining an otherwise valid pack.
- [x] Production source revisions can pin only the four approved launch mappers, while all deferred mapper code and focused tests remain compiling but unselectable.
- [x] Mapper selection is independent of source type, and generic source, scheduling, persistence, and public code contains no launch-provider branch.
- [x] Each launch implementation matches its task-002 compatibility descriptor exactly, and production composition resolves every pinned key and version once.

### Adapter-independence proof

- [x] DataForrest-equivalent and alternate-source normalized fixtures feed the unchanged Courtyard mapper when they carry the same normalized contract and identity namespace; task 006 owns executable adapter integration.
- [x] Adapter, source, and connection lineage remains protected provenance while canonical identity and revision behavior remain stable-provider scoped.
- [x] Source-type, transport-wrapper, cursor, poll, endpoint, and credential fields are absent from mapper inputs.
- [x] Equal raw IDs in different launch scopes produce distinct canonical kinds and scope-qualified relationships resolve only to the intended target; a second scope for one canonical kind is rejected.

## Verification

- PASS: focused normalized mapper, canonical lifecycle, registry, relationship, EV, availability, and dormant-provider suites (29 tests).
- PASS: `npm run test:contracts` (157 tests).
- PASS: `npm run test:services` (458 unit tests and 1 volume test).
- PASS: `npm run typecheck:contracts && npm run typecheck:services`.
- PASS: `npm run lint:contracts && npm run lint:services`.
- PASS: substantive dormant GameStop sample proof (23 records, 45 packs, 45 complete EV inputs, 1,108 assets, and 15 resolved pulls) while remaining absent from the production mapper manifest.
- PASS: `git diff --check`.

## Spec Compliance

- Related specs reviewed: none.
- Alignment: implemented the four descriptor-bound, transport-neutral launch mappers; content-only catalog revision semantics; immutable pull and market-event handling; explicit availability states; scope-qualified relationships; and complete-evidence-only EV-input candidates.
- Divergences: none. Task 006 intentionally owns the clean production importer/composition cutover and executable alternate-adapter integration; the removed legacy mapper factory is not restored as a compatibility path.
- Verification: the commands above plus an independent mapper release audit; no P1/P2 finding remains.
