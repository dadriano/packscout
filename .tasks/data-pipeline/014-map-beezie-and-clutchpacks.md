# Task: Map Beezie and ClutchPacks

**ID:** data-pipeline/014  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Turn `beezie.json` and `clutchpacks.json` into sanitized contract fixtures and list the source fields that map to pack identity, price, availability, probability buckets, values, pulls, sales, and unavailable-EV evidence.

## Objective

The cursor HTTP adapter can import every valid Beezie and ClutchPacks sample record into the shared source and canonical contracts without adding provider-specific branches to generic pipeline behavior.

## Context

Beezie catalog records represent active machines with numeric IDs, micro-unit `priceUsdc`, tier odds, tier value ranges, and selected grail or high-value items. Its sample pulls have null `pack_external_id`, and its sales use a token address as currency. ClutchPacks catalog records represent purchasable collections with USD-like string prices, average values, floors, chaser ceilings, and price-bucket odds that contain live-pool percentages and card previews. Its sample pulls also have null pack relationships, while sale events include `Minted`, `Sale`, and `Shipped` with nullable currency or amount.

The full provider payload remains raw for ninety days. Mapping extracts shared PackScout fields, preserves provider-reported EV separately, and produces PackScout EV inputs only when probability coverage, bounds, currency, and draw semantics meet the shared calculator contract.

## Requirements

### Beezie mapping

- Register Beezie and ClutchPacks mappings through the provider adapter registry; keep their field names, parsing, classifications, and source-specific reason codes inside their mapping boundaries.
- Map every Beezie machine to a canonical pack with stable external identity, name, status, price, category evidence, source times, provider EV, buyback or fee evidence, image references, and provenance supplied by the source.
- Convert Beezie USDC micro-units only after the token and unit contract is verified by the mapping fixture; never treat an unverified sales token address as USD or a verified stablecoin.
- Map Beezie odds and value ranges into probability buckets only when their semantics, total coverage, bounds, and basis are unambiguous. Treat grail lists and selected items as supporting assets or top-chase evidence, not proof of complete inventory.
- Map Beezie pulls without inventing pack links when the source relationship is null, and map sales with original event type, transaction identity, nullable values, and supported canonical category.

### ClutchPacks and shared outcomes

- Map each ClutchPacks collection to a canonical pack with stable identity, category, title, price, sold-out state, images, provider average value, floor, chaser evidence, and provenance.
- Parse ClutchPacks formatted price and value strings deterministically, rejecting malformed or ambiguous numeric formats instead of silently truncating them.
- Map ClutchPacks price buckets into EV inputs when live-pool percentages form complete coverage and min/max values, currency, and basis are usable; keep preview or partial pool cards as supporting evidence.
- Map ClutchPacks pulls without inventing pack links and map sale, mint, and shipment events while preserving original types, nullable values, transaction identities, and canonical categories.
- Produce an unavailable PackScout EV reason when either provider lacks complete or unambiguous inputs, while retaining the pack and separately labelled provider values.

## User-Facing Behavior

No provider-specific UI is introduced. Downstream consumers see Beezie and ClutchPacks packs, availability, prices, provider EV evidence, PackScout estimate or unavailable reason, supporting assets, pulls, and sale events through the same canonical shapes used by every platform.

## Interface Contract

Each mapping accepts one validated envelope from its platform and returns zero or more canonical candidates plus mapping evidence and per-record failures. Beezie uses stable machine identity; ClutchPacks uses stable collection identity. Null source relationships remain null and recoverable.

EV candidate output follows the shared bucket contract and declares currency, basis, draw count, coverage, source time, and source record. Provider-reported average or EV fields never enter the PackScout estimate as a substitute for bucket inputs.

## Acceptance Criteria

- [ ] Every valid catalog, pull, and sale envelope in `beezie.json` and `clutchpacks.json` imports or idempotently repeats, and intentionally empty or nullable fields do not become false errors.
- [ ] Prices, statuses, event categories, transaction identities, source times, supporting assets, and null pack links map to the documented canonical values.
- [ ] Complete supported bucket fixtures calculate PackScout Estimated EV; incomplete coverage, ambiguous basis, invalid numbers, or unverified currency keep the pack with a stable unavailable reason.
- [ ] Provider-reported values remain separate, raw fields remain replayable for ninety days, and canonical actor data contains no username or raw wallet address.
- [ ] Adding or changing either mapping requires no provider-name branch in generic ingestion, persistence, scheduling, quarantine, calculation, or notification behavior.
