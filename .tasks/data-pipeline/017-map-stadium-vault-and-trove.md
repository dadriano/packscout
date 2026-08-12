# Task: Map Stadium Vault and Trove

**ID:** data-pipeline/017  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** done

## Objective

The cursor HTTP adapter can import Stadium Vault and Trove packs, supporting assets, pulls, and EV distributions while treating their valid empty sales arrays correctly.

## Context

Stadium Vault catalog records are purchasable packs with category, enabled and sold-out state, USD price, effective or base odds tiers, and top possible pulls. Pull records include pack identity and detailed card values. Trove catalog records are purchasable pack definitions with price, availability, cards per pack, tier probabilities and ranges, grails, and category data. Trove pulls contain pack, collectible, market-value, grading, and user details. Both sample sales arrays are empty.

The provider mappings must distinguish probability distributions from top-chase or grail examples. PackScout Estimated EV uses complete bucket bounds and declared per-pack or per-draw semantics; top possible pulls and grails are supporting assets, not distribution coverage.

## Requirements

### Stadium Vault mapping

- Register Stadium Vault and Trove mappings through the provider adapter registry and isolate their source fields and parsing locally.
- Map Stadium Vault packs with stable identity, title, category, enabled and sold-out availability, USD price, imagery, source times, odds evidence, and provenance.
- Prefer Stadium Vault's documented effective odds distribution when present; use base odds only under a provider-local contract that proves it is the active complete distribution.
- Map Stadium Vault top possible pulls as supporting assets with value and image evidence, not as complete inventory or direct probability inputs.
- Map Stadium Vault pulls with pack relationships, item values, grading or category evidence, source times, and pseudonymous actor inputs.

### Trove and shared outcomes

- Map Trove pack definitions with stable identity, name, category evidence, availability, price, cards per pack, imagery, tier semantics, provider version, source times, and provenance.
- Map Trove tiers into EV inputs using probability, value bounds, declared basis, and cards-per-pack draw count only when the provider-local contract makes their semantics unambiguous and coverage complete.
- Map Trove grails and detailed pulled collectibles as supporting assets or event evidence without using a partial list as a full distribution.
- Map Trove pulls with pack relationships, item identities, values, grading or category evidence, source times, and pseudonymous actor inputs.

### Shared outcomes

- Accept both empty sales arrays as successful input and produce no fabricated sale events.
- Emit stable unavailable reasons when effective odds, tier coverage, bounds, basis, draw count, price, or supported currency requirements are not met.

## User-Facing Behavior

No provider-specific UI is introduced. Stadium Vault and Trove packs, status, price, pulls, supporting top items, and EV estimate or unavailable reason use the same canonical shapes as all other platforms. Lack of sales support appears as no sales data, not an ingestion error.

## Interface Contract

Pack candidates carry stable source identity and shared fields. Supporting top-pull or grail candidates carry related pack keys and source values. Pull candidates preserve source pack keys and safe canonical fields.

EV candidates specify which active tier set was used, probability coverage, lower and upper values, USD currency, `per_pack` or `per_draw` basis, draw count, source revisions, and source time. Provider mapping evidence explains why a distribution is accepted or unavailable.

## Acceptance Criteria

- [x] Every valid envelope in `stadium_vault.json` and `trove.json` imports or idempotently repeats, including valid empty sales arrays.
- [x] Pack status, price, category, source time, pulls, top-pull or grail assets, and late relationships map to the documented canonical values.
- [x] Active complete tier distributions with supported bounds and basis calculate the documented estimate, including Trove cards-per-pack semantics.
- [x] Partial top lists, missing or ambiguous active odds, incomplete probabilities, invalid bounds, or ambiguous draw semantics preserve the pack with a stable unavailable reason.
- [x] Mapping changes remain provider-local and canonical actor data, logs, errors, metrics, notifications, and browser responses exclude raw identities and payloads.

## Spec Compliance

- Added provider-local Stadium Vault effective/base-odds and Trove active-tier mappings with explicit completeness and draw semantics.
- Projected all packs, 348 supporting top-pull/grail assets, 30 pulls, and valid empty sales without treating partial top lists as inventory coverage.
- Verified exact supplied hashes and mapped/projected all 59 envelopes deterministically; every complete distribution calculates PackScout Estimated EV.
- Kept Trove actor inputs behind the shared pseudonymizer and proved canonical output omits raw account identities and payloads.
