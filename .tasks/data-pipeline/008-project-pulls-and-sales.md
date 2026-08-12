# Task: Project Pulls and Sales

**ID:** data-pipeline/008  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/002](002-establish-provider-feed-contract.md), [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md)  
**Blocks:** [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout retains complete, idempotent pull and sale-event history across providers while protecting actor identity and preserving events whose pack or asset relationship is not yet known.

## Context

Every sample supplies pulls, but Beezie and ClutchPacks provide null `pack_external_id` values and several other samples reference packs outside the returned catalog page. Five platforms provide sales in the sample set; the remaining three return valid empty sales arrays. Provider event types include sale, mint, transfer, listing, unlisting, shipment, and buyback behaviors, with nullable amounts and currencies.

Raw records preserve the complete provider payload for ninety days. Canonical events retain shared analytic fields and a pseudonymous provider actor key when correlation is needed. They never retain source usernames or raw wallet addresses.

## Requirements

### Canonical event behavior

- Project pulls with platform, source external identity, nullable pack external identity, nullable resolved pack identity, occurred and collected times, item or asset identity, provider value and currency, value source, pseudonymous actor key, source provenance, and mapped attributes supplied by the adapter.
- Project sales or lifecycle events with platform, source external identity, provider event type, canonical event category, transaction hash, nullable amount and currency, occurred and collected times, related asset or pack keys, pseudonymous actor keys, and source provenance.
- Preserve the provider event type exactly while mapping recognized meanings into a constrained canonical category. Map unrecognized valid types to `other` instead of rejecting the record.
- Accept empty sales arrays as a normal provider page. Accept nullable sale amount or currency and nullable pull pack relationships when the outer contract allows them.

### Privacy, history, and recovery

- Derive pseudonymous actor keys through a stable one-way process scoped to provider and organization. Do not place usernames, profile images tied to usernames, or raw wallet addresses in canonical event projections.
- Upsert events idempotently by platform, record kind, and source external identity. Create a correction revision when accepted canonical content changes, while preserving the original source and revision history.
- Persist unresolved relationship keys and reconcile them when a matching pack or catalog asset arrives. Never drop an event because the current catalog page lacks its related record.
- Quarantine malformed identities, timestamps, non-finite amounts, invalid adapter outputs, and projection failures with stable reason codes.

## User-Facing Behavior

No direct browser behavior in this task. Downstream product and operator surfaces can query pulls and sales consistently, distinguish source event types from canonical categories, identify unresolved relationships, and use pseudonymous actor correlation without revealing source identities.

## Interface Contract

Pull and sale projections expose canonical identity, platform, source relationship keys, resolved relationship IDs, event time, collection time, shared value fields, pseudonymous actors, source record ID, and adapter mapping version. Relationship reconciliation consumes platform plus source external keys and returns the number of newly linked current projections.

Known canonical sale categories are constrained and provider-neutral; the original provider event type remains a separate string. Projection outcomes are accepted, unchanged, revised, or quarantined.

## Acceptance Criteria

- [x] Linked, unlinked, null-link, out-of-page-link, empty-sales, null-amount, null-currency, known-event, and unknown-event fixtures import with the approved outcomes.
- [x] Later catalog arrival resolves pull and sale relationships without duplicating events or rewriting raw source evidence.
- [x] Replayed events are idempotent, corrected events create revisions, and source type plus canonical category remain distinguishable.
- [x] Canonical event records, API responses, logs, and audit entries contain no source username or raw wallet address while pseudonymous correlation remains stable within scope.
- [x] Invalid event records quarantine independently and never prevent unrelated valid pulls or sales from importing.

## Spec Compliance

- Added provider-neutral pull and sale/lifecycle projectors with constrained canonical categories while preserving the original provider event type.
- Kept nullable pack, asset, amount, currency, and transaction links explicit and recoverable through shared relationship commands.
- Added provider-scoped HMAC actor pseudonyms that remain stable inside one organization/provider boundary without retaining usernames or raw wallet addresses.
- Proved idempotent replay, correction history, late pack reconciliation, independent invalid outcomes, and protected persistence with service and PGlite integration tests.
