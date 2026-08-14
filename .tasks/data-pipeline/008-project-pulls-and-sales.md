# Task: Project Pulls and Trades

**ID:** data-pipeline/008  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md)  
**Blocks:** [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout retains complete, idempotent pull and trade-event history across providers while protecting actor identity and preserving events whose pack or asset relationship is not yet known.

## Context

The August 13 V2 archive supplies pulls and trades for Collector Crypt and Courtyard. Pulls use authoritative outer `pack_id` and nullable `card_id`; trades use authoritative outer `card_id`, `event_type`, and `tx_hash`. Provider event types include sale, buyback, mint, burn, transfer, list, unlist, swap, and ship behaviors, with nullable amounts and currencies.

Raw records preserve the complete provider payload for ninety days. Canonical events retain shared analytic fields and a pseudonymous provider actor key when correlation is needed. They never retain source usernames or raw wallet addresses.

## Requirements

### Canonical event behavior

- Project pulls with platform, source external identity, nullable pack external identity, nullable resolved pack identity, occurred and collected times, item or asset identity, provider value and currency, value source, pseudonymous actor key, source provenance, and mapped attributes supplied by the adapter.
- Project trades or lifecycle events with platform, source external identity, canonical event category, transaction hash, nullable amount and currency, occurred and collected times, related asset or pack keys, pseudonymous actor keys, and source provenance. The exact raw provider event type remains in protected source evidence; a bounded, whitespace-normalized provider value also remains in protected canonical PostgreSQL evidence. Neither is publicly promoted.
- Preserve the exact provider event type in source evidence while mapping its normalized meaning into a constrained canonical category. Map unrecognized valid types to `other` instead of rejecting the record.
- Accept nullable trade amount or currency and nullable pull card relationships when the V2 outer contract allows them.

### Privacy, history, and recovery

- Derive pseudonymous actor keys through a stable one-way process scoped to provider and organization. Do not place usernames, profile images tied to usernames, or raw wallet addresses in canonical event projections.
- Persist pulls and trades as immutable events keyed by platform, record kind, and source external identity. An exact replay records another observation without a canonical revision; conflicting facts quarantine as `IMMUTABLE_EVENT_CONFLICT` instead of rewriting history.
- Persist unresolved relationship keys and reconcile them when a matching pack or catalog asset arrives. Never drop an event because the current catalog page lacks its related record.
- Quarantine malformed identities, timestamps, non-finite amounts, invalid adapter outputs, and projection failures with stable reason codes.

## User-Facing Behavior

No direct browser behavior in this task. Downstream product and operator surfaces can query pulls and trades consistently, distinguish canonical lifecycle categories, identify unresolved relationships, and use pseudonymous actor correlation without revealing source identities.

## Interface Contract

Pull and trade projections expose canonical identity, platform, source relationship keys, resolved relationship IDs, event time, collection time, shared value fields, pseudonymous actors, source record ID, and adapter mapping version. Relationship reconciliation consumes platform plus source external keys and returns the number of newly linked current projections.

Known canonical trade categories are constrained and provider-neutral. Projection outcomes are accepted, unchanged, or quarantined; immutable source events are never revised in place.

## Acceptance Criteria

- [x] Linked, unlinked, null-link, out-of-page-link, null-amount, null-currency, known-event, and unknown-event fixtures import with the approved outcomes.
- [x] Later catalog arrival resolves pull and trade relationships without duplicating events or rewriting raw source evidence.
- [x] Exact event replay is idempotent, while conflicting facts quarantine without changing accepted canonical history.
- [x] Canonical event records, API responses, logs, and audit entries contain no source username or raw wallet address while pseudonymous correlation remains stable within scope.
- [x] Invalid event records quarantine independently and never prevent unrelated valid pulls or trades from importing.

## Spec Compliance

- Added provider-neutral pull and trade/lifecycle projectors with constrained canonical categories while retaining raw provider values in protected PostgreSQL evidence and excluding them from public promotion.
- Kept nullable pack, asset, amount, currency, and transaction links explicit and recoverable through shared relationship commands.
- Added provider-scoped HMAC actor pseudonyms that remain stable inside one organization/provider boundary without retaining usernames or raw wallet addresses.
- Proved idempotent replay, immutable-conflict quarantine, late pack reconciliation, independent invalid outcomes, and protected persistence with real PostgreSQL integration tests.
