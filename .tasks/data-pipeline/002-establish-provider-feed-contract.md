# Task: Establish the Provider Feed Contract

**ID:** data-pipeline/002  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** none  
**Blocks:** [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md)  
**Estimated scope:** medium  
**Status:** not started

## Start Here

Turn one supplied `packscout-data` sample into a contract fixture that proves the outer `catalog`, `pulls`, and `sales` envelopes without encoding that platform's nested `data` shape into the shared contract.

## Objective

Every provider adapter and ingestion workflow shares one validated, provider-neutral cursor-page contract while provider-specific payload interpretation remains isolated behind registered adapters.

## Context

All eight samples share stable outer record shapes but contain sharply different nested payloads. Catalog arrays may contain packs, parent groups, purchasable variants, inventory cards, price records, or other supporting assets. Pulls may omit `pack_external_id`, and sales may be empty or use platform-specific event types and currencies. Generic ingestion must never branch on a platform key or assume a provider's nested fields.

The first adapter performs an HTTP GET. It sends `platform` on every request and sends an opaque `cursor` after a durable checkpoint exists. Authentication mode is either no authentication or a server-side bearer token. The provider response adds pagination metadata beside the three arrays represented by the samples.

## Requirements

### Page and record shapes

- Define a provider page containing `catalog`, `pulls`, `sales`, `next_cursor`, and `has_more`; reject missing arrays, invalid metadata, and non-object records before any canonical write.
- Define catalog envelopes with `platform`, `external_id`, `updated_at`, `collected_at`, and opaque object `data`.
- Define pull envelopes with `platform`, `external_id`, nullable `pack_external_id`, `occurred_at`, `collected_at`, and opaque object `data`.
- Define sale envelopes with `platform`, `external_id`, `event_type`, non-empty `tx_hash`, nullable numeric `amount`, nullable `currency`, `occurred_at`, `collected_at`, and opaque object `data`.

### Validation and adapter boundaries

- Require non-empty platform and external identities, parseable timestamps, finite numeric amounts, and exact agreement between the requested platform and every returned record.
- Treat `next_cursor` as opaque and non-empty for an accepted page. Reject a continuing page when `has_more` is true but the cursor does not advance or all three arrays are empty.
- Define adapter outputs for canonical pack, catalog asset, pull, sale, and EV-input candidates, including source identity, source timestamps, relationship keys, data-quality evidence, and pseudonymous actor inputs.
- Keep the adapter registry generic: adding a provider mapping registers provider-local behavior without adding provider-name branches to ingestion, persistence, scheduling, or calculation flows.

## User-Facing Behavior

No direct user-facing behavior. Operators later see contract failures as stable connection-test or run errors that name the invalid field path without exposing the raw payload.

## Interface Contract

The request is `GET <configured endpoint>?platform=<platform>` for the first page and adds `cursor=<opaque checkpoint>` afterward. The response contract is:

```text
ProviderPage {
  catalog: CatalogEnvelope[]
  pulls: PullEnvelope[]
  sales: SaleEnvelope[]
  next_cursor: string
  has_more: boolean
}
```

The shared adapter boundary accepts a validated `ProviderPage` plus provider configuration identity and returns classified canonical candidates and per-record validation results. It never mutates persistence, advances a cursor, emits notifications, or reads browser state. Downstream tasks can validate the page once, persist it durably, and process each record without knowing the provider's nested schema.

## Acceptance Criteria

- [ ] Contract fixtures derived from all eight sample files validate their outer envelopes, including empty sales arrays, nullable pull relationships, nullable sale amounts or currencies, and opaque nested data.
- [ ] Missing arrays, malformed timestamps, platform mismatches, invalid amounts, non-object data, and non-advancing continuing cursors fail with stable field-level errors.
- [ ] Provider-specific keys do not appear in generic orchestration branches, and a test adapter can be registered without modifying the ingestion workflow.
- [ ] Request construction omits the cursor for an initial backfill, preserves opaque cursor bytes thereafter, and supports authentication modes `none` and `bearer` without exposing the secret.
- [ ] The contract remains runtime-neutral and usable by persistence, scheduling, admin APIs, and tests through intentional public boundaries.
