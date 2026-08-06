# Task: Map GameStop and Phygitals

**ID:** data-pipeline/016  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** not started

## Start Here

Turn `gamestop.json` and `phygitals.json` into sanitized contract fixtures and document how nested levels or variants become stable, independently purchasable pack projections without losing their parent grouping.

## Objective

The cursor HTTP adapter can import GameStop's nested pack levels and Phygitals' parent or variant packs, events, and probability evidence through shared PackScout contracts.

## Context

GameStop catalog envelopes describe categories whose `levels` are independently purchasable options with distinct IDs, names, prices, availability, tiers, and chase cards. Pull envelopes identify the category and carry level name, level price, asset slug, rarity, and item value. The sample sales array is empty and valid.

Phygitals catalog records expose root packs and nested variants with distinct IDs or slugs, prices, categories, stock, provider EV, buyback percentage, rarity distributions, chase cards, and pull counts. Pull and buyback-sale payloads contain deeply nested marketplace and collectible data. The shared canonical contract must extract needed fields without copying those nested schemas into generic code.

## Requirements

### GameStop mapping

- Register GameStop and Phygitals mappings through the provider adapter registry and keep source-specific parsing and classification local.
- Map each GameStop category as a parent catalog grouping and each independently purchasable level as a canonical pack using a stable level identity, parent relationship, price, availability, category, title, images, tiers, chase assets, and provenance.
- Resolve a GameStop pull to the most specific stable level when category, asset slug, level name, and price evidence identify it; otherwise retain the source category relationship as unresolved instead of guessing.
- Accept GameStop's empty sales array as normal and preserve pull item values, grading, imagery, rarity, and source times through shared pull and asset fields.
- Convert GameStop tier probabilities and value ranges into EV inputs only when coverage, currency, basis, and draw semantics meet the shared calculator contract.

### Phygitals and shared outcomes

- Map each independently purchasable Phygitals root or variant to a distinct canonical pack with stable identity, parent relationship, price, stock, enabled state, category, images, provider EV, buyback percentage, draw count, and source times.
- Avoid duplicate canonical packs when a Phygitals variant appears nested under a parent and later as its own source record; stable provider identity and parent relationship govern idempotency.
- Convert Phygitals rarity weights and bounds into EV inputs only when coverage, currency, basis, and draw semantics meet the shared calculator contract; keep provider EV separate and emit unavailable evidence for incomplete or ambiguous distributions.
- Map Phygitals chase cards and nested collectible or marketplace records as supporting assets and provenance evidence without treating them as complete inventory unless the adapter can prove completeness.
- Map Phygitals pulls and buyback sales with source identities, relationship keys, values, transaction identity, event type, source times, and pseudonymous actor inputs while omitting canonical usernames and wallets.

## User-Facing Behavior

No provider-specific UI is introduced. GameStop levels and Phygitals variants appear as separate comparable packs with their parent grouping preserved. Pulls link to the most specific supported pack or remain visibly unresolved, and missing sales support is not shown as a provider failure.

## Interface Contract

One GameStop catalog envelope may emit one parent asset plus several pack candidates. One Phygitals envelope may emit a parent pack, variant packs, and supporting assets. Candidate stable identities and parent keys must remain identical across nested and standalone appearances.

EV candidates declare normalized probability, bounds, currency, basis, draw count, coverage, source time, and source revisions. Deep nested payloads remain source-only unless a field is explicitly projected by the provider mapping.

## Acceptance Criteria

- [ ] Every valid envelope in `gamestop.json` and `phygitals.json` imports or idempotently repeats, including GameStop's empty sales and Phygitals' deeply nested event payloads.
- [ ] GameStop levels and Phygitals variants become stable distinct packs with correct parent relationships and no duplicates across retry or nested-versus-standalone appearances.
- [ ] Pulls resolve to the most specific supported pack without guessing, and unresolved source relationships remain available for later reconciliation.
- [ ] Supported complete tier distributions calculate PackScout Estimated EV; incomplete, ambiguous, unsupported-currency, or partial-inventory inputs preserve the pack with an unavailable reason.
- [ ] Provider-specific details remain isolated, provider EV stays separate, and canonical or browser-visible data excludes source usernames, raw wallets, and full raw payloads.
