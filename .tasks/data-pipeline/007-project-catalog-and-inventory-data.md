# Task: Project Catalog and Inventory Data

**ID:** data-pipeline/007  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md)  
**Blocks:** [data-pipeline/009](009-calculate-estimated-ev.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** todo

## Objective

PackScout maintains provider-neutral current and historical projections for every purchasable pack and supporting catalog or inventory asset represented by the eight feeds.

## Context

The source `catalog` name does not mean every row is a pack. Collector Crypt mixes `card:` records with `gacha:` packs. Courtyard mixes `price:` asset records with packs. GameStop places multiple purchasable levels inside a category record, and Phygitals exposes parent and variant relationships. Other platforms embed odds buckets, top chases, partial pools, or inventory lists inside a pack record.

For PackScout, a canonical pack is an independently purchasable option with its own stable source identity or adapter-derived stable variant identity, price, and pack behavior. Parent collections, cards, price records, and inventory items are supporting catalog assets. Every source record remains available raw for ninety days even when it produces several projections.

## Requirements

### Classification and canonical fields

- Accept registered adapter candidates and classify them as purchasable packs or supporting catalog assets without adding platform-name branching to shared projection behavior.
- Project pack identity, parent relationship, platform, name, category, description, availability, source status, price value and currency, provider-reported EV, buyback percentage, draw count, image references, source timestamps, and source provenance when supplied.
- Project supporting asset identity, related pack or parent identity, asset type, name, category, provider value and currency, value source, availability, image references, source timestamps, and provenance when supplied.
- Project canonical EV inputs as probability buckets with finite probability, lower and upper value bounds, currency, basis `per_pack` or `per_draw`, draw count, source time, and adapter evidence; preserve top-chase records separately from probability coverage.
- Treat each independently purchasable nested variant as a canonical pack with a stable identity and a relationship to its source parent. Do not collapse differently priced or differently distributed variants into one row.

### History, quality, and relationships

- Preserve provider-reported values and PackScout calculation inputs separately so source EV is never overwritten by PackScout Estimated EV.
- Upsert revision history and current projections idempotently. Do not create a revision for equivalent canonical content.
- Never infer deletion or inactivity from absence in an incremental page. Apply only an explicit mapped source status, while freshness is handled independently at the platform level.
- Quarantine structurally invalid or unclassifiable catalog records. Keep valid packs whose EV inputs are incomplete and attach data-quality evidence for an unavailable estimate.
- Reconcile supporting assets and pack relationships when either side arrives later, without discarding or duplicating the earlier projection.

## User-Facing Behavior

No direct browser behavior in this task. Downstream consumers receive consistent pack rows and supporting assets across platforms, including availability, price, provider EV, PackScout EV-input readiness, source timestamps, and provenance.

## Interface Contract

A pack projection exposes `platform_key`, `external_id`, `parent_external_id`, `name`, `category`, `availability`, `price_value`, `price_currency`, `provider_reported_ev`, `buyback_percent`, `draw_count`, `source_updated_at`, `source_collected_at`, and `source_record_id`, with nullable fields represented explicitly.

A catalog asset projection exposes stable source identity, asset type, related pack or parent key, display and value fields, and provenance. An EV-input set exposes bucket IDs, probability, lower and upper values, currency, basis, draw count, coverage evidence, and source time. The projection boundary returns accepted, unchanged, revised, or quarantined per candidate.

## Acceptance Criteria

- [ ] Mixed catalog fixtures produce the correct pack, parent, variant, card, price-record, and inventory-asset projections without provider logic in shared persistence.
- [ ] Independently purchasable nested variants remain distinct, stable pack rows and keep their parent relationship across repeated imports and source updates.
- [ ] Equivalent records are idempotent, changed records create history, explicit provider statuses update current availability, and page omission never deletes a pack.
- [ ] Partial inventory, top-chase-only data, missing bounds, and incomplete probability coverage keep the pack available while producing explicit EV-readiness evidence.
- [ ] Source provenance and late relationship reconciliation work across all canonical catalog kinds without leaking raw payloads to browser callers.
