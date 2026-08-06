# Task: Map Collector Crypt and Courtyard

**ID:** data-pipeline/015  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Turn `collector_crypt.json` and `courtyard.json` into sanitized contract fixtures and prove that one source catalog array can produce both purchasable packs and supporting card or price-asset records.

## Objective

The cursor HTTP adapter can classify and import Collector Crypt and Courtyard's mixed catalogs, pulls, sales, and EV evidence through shared PackScout contracts.

## Context

Collector Crypt catalog records use `card:` external identities for individual collectibles and `gacha:` identities for purchasable machines. Gacha records include price, target or maximum EV evidence, tier ranges, weights, top NFTs, and pack settings; card records contain item, ownership, listing, grade, and insured-value details. Pulls reference gacha packs, while sales include listing, sale, and unlisting actions.

Courtyard catalog records use `price:` identities for asset price records alongside pack records with sale price, provider expected value, buyback ratio, inventory, odds buckets, status, and imagery. Pulls can reference packs outside the current sample page. Sales include mint, sale, and transfer events with nullable payment values or currencies.

## Requirements

### Collector Crypt mapping

- Register Collector Crypt and Courtyard mappings through the provider adapter registry and isolate every source-field rule within its platform mapping.
- Classify Collector Crypt `gacha:` records as packs and `card:` records as supporting catalog assets using stable source identities; preserve their relationship and provenance evidence without treating cards as purchasable packs.
- Map Collector Crypt pack price, availability, category, title, provider target or maximum EV fields, buyback evidence, images, draw settings, and source times into the approved canonical fields.
- Treat Collector Crypt tier ranges, weights, and top-NFT lists as PackScout EV inputs only when they form a complete, unambiguous probability distribution with usable value bounds and basis; otherwise emit calculation-readiness reasons.
- Map Collector Crypt pulls plus list, sale, and unlisted events with recoverable relationships, original event types, canonical categories, transaction evidence, and pseudonymous actors.

### Courtyard and shared outcomes

- Classify Courtyard `price:` records as supporting valued assets and pack records as canonical packs, retaining stable external identities and late-resolvable relationships.
- Map Courtyard sale price, provider expected value, buyback ratio, status, out-of-stock state, category, images, inventory assets, odds buckets, and source times.
- Produce Courtyard EV buckets from documented complete odds and bounds; treat item inventory and heavy-hitter lists as supporting assets and coverage evidence without double-counting them.
- Map Courtyard pulls plus mint, sale, and transfer events with nullable or out-of-page relationships, original event types, canonical categories, transaction evidence, and pseudonymous actors.
- Keep provider-reported EV separate from PackScout Estimated EV and retain packs with explicit unavailable reasons when complete supported calculation inputs are absent.

## User-Facing Behavior

No provider-specific UI is introduced. Collector Crypt and Courtyard appear through shared pack, catalog asset, pull, sale, and EV result shapes. Cards and price records support pack evidence without appearing as duplicate purchasable packs.

## Interface Contract

The mappings may return several canonical candidates from one validated catalog envelope. Candidate identities remain deterministic across retries and source updates. Source prefixes and nested provider types are mapping evidence, never shared orchestration conditions.

EV candidates identify exactly which source buckets, values, currencies, basis, and source revisions support the estimate. Provider target EV and expected EV populate provider-reported fields only.

## Acceptance Criteria

- [ ] Every valid envelope in `collector_crypt.json` and `courtyard.json` imports or idempotently repeats with cards, price records, packs, pulls, and sales classified correctly.
- [ ] Purchasable packs remain distinct from supporting assets, source relationships resolve when possible, and out-of-page references remain recoverable.
- [ ] Complete supported Courtyard or Collector Crypt distributions calculate the midpoint estimate, while partial top lists, incomplete weights, ambiguous basis, or unsupported values produce stable unavailable evidence.
- [ ] Provider EV, expected value, or target EV never substitutes for PackScout Estimated EV and remains separately labelled with source time.
- [ ] Provider-specific parsing remains isolated and canonical actor, error, log, metric, notification, and browser data contain no raw identity or payload leakage.
