# Technical Spec: Canonical Projections and Estimated EV

> **Superseded implementation artifact (2026-08-14).** Historical aggregate V1/eight-provider evidence only; do not build it. Use the record-stream V2 contract in [`docs/provider-data-contract-v2.md`](../../docs/provider-data-contract-v2.md).

**Spec ID:** tech-004  
**Related tasks:** [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md)  
**Depends on tech specs:** [tech-002](tech-002-provider-feed-storage-and-history.md), [tech-003](tech-003-ingestion-orchestration-and-reliability.md)  
**Spec status:** superseded (historical V1 evidence)

## Purpose

Define provider-neutral catalog, inventory, pull, sale, and estimated-value models while preserving immutable history, source provenance, unresolved relationships, privacy boundaries, and honest calculation limitations.

## Current System Context

- No canonical domain model or projection code exists in the repository.
- The samples use stable outer identities but materially different nested structures for pack definitions, cards, odds tiers, prices, pulls, and sales.
- Some providers expose detailed odds or inventory; others expose only partial estimates, tier ranges, or no sale feed.
- Pull records may lack a usable pack link, and sale amount/currency can be null.
- The product decision is to label the result “PackScout Estimated EV,” not true EV, when detailed item inventory is unavailable.

## Proposed Implementation

### Projection boundary

Define one mapper per provider and feed record kind. Mappers accept a validated immutable source record plus a projection context and return provider-neutral commands, warnings, or a typed quarantine reason.

Mappers do not access the network or database. The projection service resolves canonical identity, writes revisions/current views, attaches provenance, and queues relationship or EV recomputation work in the same page transaction.

### Canonical identity and history

Use `(organization_id, platform_key, external_id)` as the canonical external identity for packs and assets. Keep an immutable revision whenever the normalized content hash changes, and point a current table to the latest revision.

Provider-local variant, category, collection, and pack relationships remain explicit edges with source provenance. Do not synthesize cross-provider asset identity in this feature.

### Catalog and inventory

Represent a sellable pack or machine as a canonical `pack`, with current price, currency, availability, supply evidence, images, descriptions, categories, and source timestamps. Represent cards or collectibles as `assets`, and pack-to-asset/variant information as evidence records rather than claiming a full live inventory.

Normalize monetary values to integer minor units plus an ISO-like currency code. Version one accepts USD and explicitly verified USD stablecoins for EV; all other currencies remain stored but produce an unavailable EV reason.

### Pulls and sales

Pulls and sales are append-only canonical events deduplicated by platform and external ID. Actor identifiers are converted to organization-scoped HMAC pseudonyms before canonical persistence; raw identifiers survive only inside expiring raw evidence.

Unknown pack or asset links create unresolved relationship rows. Reconciliation runs when catalog records arrive and in a periodic bounded worker job.

### Estimated EV

Calculate EV from the best supported evidence tier:

1. Exact item probabilities and values when both are present.
2. Probability bucket midpoints multiplied by representative bucket values when ranges are present.
3. Provider-supplied EV when its currency, unit, and timestamp pass validation.
4. Otherwise mark EV unavailable with a stable reason.

Store the method, formula version, input source revisions, currency treatment, unit basis (`per_pack` or `per_draw`), computed timestamp, and limitation flags. Never present a partial-inventory calculation as exact or as “true EV.”

## Code Changes

### Contracts and domain services

- Add canonical DTOs, monetary types, provenance types, EV methods, and reason codes to `packages/contracts`.
- Add pure provider mapper modules under `packages/services/src/providers/<provider-key>`.
- Add identity, projection, relationship-reconciliation, and EV calculator services.
- Add golden fixture expectations derived from each sample provider without embedding provider branches in generic projection code.

### Public exports and ownership

- Export browser-safe read DTOs from `packages/contracts`; keep mapper inputs and database row types server-only.
- Keep the existing frontend independent; no public route is added by this feature.
- Expose canonical read services for future consumers instead of allowing direct table reads from apps.
- Version formulas and mapper behavior explicitly so history remains explainable after changes.

## Database / Schema Changes

### Catalog entities

Create `packs(id, organization_id, platform_key, external_id, current_revision_id, first_seen_at, last_seen_at)` and immutable `pack_revisions(id, pack_id, source_record_id, normalized_hash, name, description, price_minor, currency, availability, supply_count, source_updated_at, normalized_json, created_at)`.

Create matching `assets` and `asset_revisions` tables for collectible identity and mutable attributes. Add `pack_relationships` for parent/variant/category/collection relationships with valid-from/source provenance.

### Probability and inventory evidence

Create `pack_value_evidence(id, pack_revision_id, source_record_id, evidence_kind, label, probability_min, probability_max, value_min_minor, value_max_minor, representative_value_minor, currency, quantity, metadata_json)`.

This table records what the provider disclosed. It does not imply PackScout knows the full remaining machine inventory.

### Canonical events and relationships

Create `pull_events(id, organization_id, platform_key, external_id, pack_id, asset_id, actor_key, occurred_at, source_record_id, normalized_json, created_at)` and `sale_events(id, organization_id, platform_key, external_id, asset_id, event_type, amount_minor, currency, transaction_key, actor_from_key, actor_to_key, occurred_at, source_record_id, normalized_json, created_at)`.

Create `unresolved_relationships(id, organization_id, relationship_kind, source_record_id, source_external_id, target_kind, target_platform_key, target_external_id, state, attempt_count, last_attempt_at, resolved_entity_id, resolved_at)`.

### EV history

Create `estimated_ev_calculations(id, organization_id, pack_id, pack_revision_id, formula_version, method, unit_basis, value_minor, currency, status, unavailable_reason, limitation_flags, input_manifest_json, calculated_at)` and place `current_estimated_ev_id` on `packs`.

The input manifest contains only stable revision/evidence identifiers and normalized factors, not expiring raw payloads.

## Interfaces, APIs, Endpoints

### Mapper interface

```ts
interface ProviderRecordMapper {
  mapCatalog(record: SourceRecord): MappingResult<PackProjectionCommand>;
  mapPull(record: SourceRecord): MappingResult<PullProjectionCommand>;
  mapSale(record: SourceRecord): MappingResult<SaleProjectionCommand>;
}
```

`MappingResult` is either commands plus warnings or a typed failure with reason code and field path. Provider differences stay behind this interface.

### Read service contracts

- `getPackCurrent(packId, organizationId)` returns the current canonical pack, evidence summary, EV, limitations, and provenance timestamps.
- `listPackHistory(...)` uses keyset pagination over immutable revisions.
- `listUnresolvedRelationships(...)` returns sanitized reconciliation state for operations.
- `explainEstimatedEv(...)` returns method, inputs, unit, currency, formula version, and unavailable reason without raw provider JSON.

## Data Flow

1. The page transaction sends each valid source record to the platform mapper selected by the provider registry.
2. The mapper returns canonical commands and warnings, or a quarantine reason for unusable data.
3. The projection service resolves identity, inserts a revision only on normalized change, and updates the current pointer.
4. Pulls/sales attach known relationships or create unresolved rows without blocking the rest of the page.
5. Changed pack evidence queues deterministic EV recomputation and preserves the prior calculation history.

## Error Handling and Edge Cases

- Missing optional fields create explicit nulls or warnings; required identity, timestamp, or structurally unusable data is quarantined.
- Unknown currencies, conflicting unit bases, stale provider EV, incomplete probability mass, or unusable value ranges return stable unavailable or limited reasons.
- Probability totals outside an agreed tolerance fail calculation rather than silently renormalizing.
- A late catalog record reconciles earlier pulls/sales without changing their immutable identity or source provenance.
- Deletes or disappearance from a provider feed update availability evidence only when the provider contract supplies a trustworthy tombstone or full-snapshot signal.

## Testing and Verification

### Mapper scenarios

- Golden tests cover Beezie, ClutchPacks, Collector Crypt, Courtyard, GameStop, Phygitals, Stadium Vault, and Trove catalog/pull/sale shapes.
- Missing sales feeds, nullable sale values, nested variants, range odds, provider EV, absent pack links, and unknown fields remain deterministic.
- Replaying a source record is a no-op; changed normalized content creates one new revision and current pointer update.
- Provider-only field changes never require branches in the generic identity, projection, or EV services.

### EV and history scenarios

- Exact inputs, midpoint ranges, provider-supplied EV, per-pack/per-draw units, USD stablecoin verification, and rounding rules have table-driven tests.
- Incomplete inventory, invalid probability mass, unsupported currency, missing value, and mixed-unit inputs return explicit limitation or unavailable codes.
- Every current value traces to immutable source and canonical revision identifiers after raw evidence expires.
- Pseudonymous actors are stable within the organization but cannot be correlated across organizations.
- Relationship reconciliation is idempotent and directly tested for late-arriving catalog data.

## Open Questions and Risks

- Confirm the accepted probability-total tolerance and integer rounding policy before calculator implementation.
- Define the verified stablecoin allowlist and ownership of its updates.
- Determine freshness limits for provider-supplied EV and valuation evidence per platform.
- Cross-provider asset matching and live remaining-machine inventory are intentionally deferred; product copy must not imply either exists.

## Handoff Notes

Implement generic identity and revision behavior with one provider mapper first, then add remaining mappers as isolated modules. Treat every displayed EV as an explainable estimate backed by stored evidence and explicit limitations.
