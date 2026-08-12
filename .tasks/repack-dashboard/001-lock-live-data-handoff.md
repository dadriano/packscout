# Task: Lock and Adopt the Live Data Handoff

**ID:** repack-dashboard/001
**Depends on:** none
**Blocks:** repack-dashboard/002, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 5–8 days for one builder, including contract fixtures, pipeline adoption, migration, and verification
**Status:** blocked

## Start Here

Collect one sanitized real response page for each of `catalog`, `pulls`, and `trades`, then record their request parameters, page wrapper, and cursor behavior in one versioned contract fixture set.

## Objective

Produce and adopt the evidence-backed live provider contract that ingestion and frontend publication can share without fabricated fields, aliases, or dual reads.

## Context

The current provider draft describes three record streams with `record_id`, `collected_at`, nullable `occurred_at`, raw `data`, and stream-specific relationship fields. The data-pipeline foundation merged through PR #1 expects a combined `catalog/pulls/sales` page with different identifiers and timestamps. Its canonical history, quarantine, and EV architecture remain useful, but its inbound V1 envelope cannot accept the draft unchanged.

This is a bounded contract task. The provider’s observed API behavior determines transport details; the approved product behavior and data ownership in the feature index do not change.

## Requirements

### Transport Evidence

- Capture the exact request path, authentication method, stream selector, page size behavior, and rate-limit signals without storing a credential.
- Capture the response wrapper, next-cursor field, end-of-stream signal, nullability, and error envelope for each stream.
- Establish whether cursors are independent per stream; catalog pack/card records continue to share the catalog cursor.
- Record ordering, cursor expiry, full-history start behavior, and correction behavior using provider evidence.
- Store sanitized golden examples that preserve nesting and casing while removing account, wallet, and secret values.

### Record Contract

- Preserve `stream`, `platform`, `record_id`, `occurred_at`, `collected_at`, and raw `data` for every record.
- Preserve `entity` and `first_seen_at` for catalog records.
- Preserve `pack_id` and `card_id` for pulls, plus `card_id`, `event_type`, `amount`, `currency`, and `tx_hash` for trades.
- Treat pulls and trades as immutable events; a conflicting repeat is quarantined rather than silently revised.
- Treat catalog records as mutable snapshots with stable identity and revision history.

### Normalization Contract

- Keep the provider event type and expose a canonical lifecycle category that recognizes list/listing and unlisted/unlisting vocabulary.
- Resolve approved token contract addresses to canonical currency symbols while retaining the raw currency reference as evidence.
- Keep nullable amount and currency values unavailable; never convert them to zero.
- Use outer `pack_id` and `card_id` as the authoritative relationship keys.
- Preserve provider raw payloads only in the protected canonical system, never in the public snapshot.

### Compatibility Boundary

- The launch provider uses one versioned stream contract rather than an alias layer over the unlaunched aggregate V1 shape.
- Provider-specific extraction remains isolated behind the shared stream contract.
- The same source cannot be read simultaneously through old and new contracts.
- Any retained adapter for a different source has a distinct registration and does not branch generic orchestration on a platform name.
- The final contract defines a removal path for superseded unlaunched fixtures and documentation.

### Pipeline Adoption

- Replace the unlaunched aggregate V1 inbound contract, fixtures, and adapter registration with `ProviderStreamContractV2`; do not retain a same-source compatibility path.
- Maintain an independent durable checkpoint for each of `catalog`, `pulls`, and `trades`, and advance only the stream whose validated page committed successfully.
- Route catalog records through mutable canonical revision semantics and pulls/trades through immutable event semantics with conflicting repeats quarantined.
- Update relationship reconciliation, event normalization, currency evidence, counters, and operator-safe diagnostics to use the V2 stream vocabulary.
- Migrate unlaunched schema and configuration state in one controlled cutover, remove superseded code, and prove backfill plus incremental resume for all three streams.

## User-Facing Behavior

None. This task protects the accuracy and freshness of every later public catalog view.

## Interface Contract

The task delivers `ProviderStreamContractV2`, containing:

| Area | Required output |
|---|---|
| Transport | Request arguments, page envelope, cursor scope, termination, retry classification |
| Common record | Stream, platform, stable record ID, source time, collection time, protected raw data |
| Catalog | Entity kind, first-seen time, pack/card identity, mutable snapshot semantics |
| Pull | Pack and card relationship IDs, immutable event semantics |
| Trade | Card relationship, raw and canonical event type, nullable money, transaction reference |

`repack-dashboard/002` consumes canonical data produced through this adopted contract. It must not infer missing transport or identity fields from raw payload conventions.

## Acceptance Criteria

### Contract Evidence

- [ ] A sanitized real page fixture exists for catalog, pulls, and trades.
- [ ] Each fixture passes the documented contract and fails when a required identity is removed.
- [ ] Cursor scope, termination, ordering, expiry, and backfill behavior are recorded from provider evidence.
- [x] Nullable timestamps and money values have explicit handling.
- [ ] No credential, wallet, username, or unredacted personal identifier appears in the fixture set.

### Integration Readiness

- [x] The contract maps every draft field without aliases or fabricated timestamps.
- [x] Catalog revisions, immutable events, and relationship keys have distinct semantics.
- [x] Event vocabulary and currency-address treatment have one canonical output while retaining raw evidence.
- [x] The data-pipeline launch scorecard names the new contract rather than the incompatible aggregate envelope.
- [ ] Task `repack-dashboard/002` can build its public snapshot without reopening transport questions.

### Adoption Evidence

- [ ] The worker stores and resumes three independent durable stream checkpoints.
- [x] Catalog corrections create canonical revisions while duplicate pulls/trades remain idempotent and conflicting repeats quarantine.
- [ ] No runtime registration, fixture, documentation, or generic branch reads the launch source through aggregate V1.
- [ ] V2 backfill, crash recovery, cursor termination, and incremental continuation pass focused integration tests.
- [ ] Operator-visible counters and sanitized failures use catalog, pulls, and trades consistently.

## Build Status

- Implemented: evidence-backed V2 record schemas and sanitized record-level fixtures; stream/platform and identity validation; nullable time/money handling; lifecycle and approved-currency normalization; outer relationship precedence; catalog-revision versus immutable-event write policy; canonical lifecycle adoption; launch-scorecard cutover language.
- Verified: contracts, database, services, and worker focused lint, typecheck, and test suites pass.
- Blocked: the provider draft supplies real records but no request path, authentication, raw page wrapper, selector/page-size rules, error/rate-limit envelope, cursor scope/termination/order/expiry, full-history start, or correction-page behavior. A decoder, runtime registration, durable three-stream checkpoints, and backfill/incremental evidence cannot be completed without inventing that protocol.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-001, repack-dashboard/tech-004, repack-dashboard/ux-005
- Alignment: implemented the evidence-preserving record contract, nullable-value rules, lifecycle/currency normalization, relationship precedence, and canonical mutable-versus-immutable write policy without inventing missing transport facts.
- Divergences: the transport decoder, same-source V1 removal, runtime registration, three durable checkpoints, and backfill/incremental proof are intentionally not implemented because the provider has not supplied the raw page/path/auth/cursor evidence required by the specs.
- Verification: focused contracts, database, services, and worker lint/typecheck/test suites recorded green for the implemented record and write-policy slice.
