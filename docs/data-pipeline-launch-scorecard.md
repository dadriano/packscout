# Data Pipeline Launch Scorecard

**Evidence date:** 2026-08-14

**Provider record contract:** PASS for the August 13 archive

**Archive import:** IMPLEMENTED; database reconciliation required per target

**Live HTTP transport:** BLOCKED on one sanitized real response wrapper

**Scheduled provider launch:** BLOCKED

## Current boundary

The production data pipeline uses `ProviderStreamContractV2`. Aggregate V1
pages and `http-cursor-v1` have been removed; there is no dual read, alias, or
compatibility path.

V2 separates two facts:

1. The August 13 archive proves every record envelope and the Collector Crypt
   and Courtyard nested mapping shapes.
2. The archive does not prove the live API page wrapper, response serialization,
   terminal cursor, headers, errors, or rate-limit signals.

The common HTTP adapter therefore accepts only a provider-local response
decoder. No production decoder is registered until a sanitized live page locks
the missing transport evidence. The internal page uses one provider cursor and
may interleave catalog, pull, and trade records.

Detailed contract: [Provider Data Contract V2](./provider-data-contract-v2.md).

## Archive evidence

Approved archive SHA-256:
`cf1306ebfc449aed187457660dd3c374afde1b4520c2f93d09718129ecfb08f8`

| Platform | Catalog | Pulls | Trades | Total | Envelope verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| Collector Crypt | 56,962 | 35,266 | 1,060 | 93,288 | PASS |
| Courtyard | 57,784 | 49,373 | 117,252 | 224,409 | PASS |
| **Total** | **114,746** | **84,639** | **118,312** | **317,697** | **PASS** |

All record identities are unique by `(platform, stream, record_id)`. Exactly
9,844 Collector Crypt pulls contain an explicit null `card_id`. V2 accepts them
as incomplete observations and maps the pack relationship without fabricating
a card or outcome value.

## Implemented gates

| Concern | Required evidence | State |
| --- | --- | --- |
| Mixed-stream record validation | Strict V2 union, platform binding, global page-order indices | PASS |
| Single provider cursor | One checkpoint per immutable configuration; repeat/cycle/length guards | PASS |
| Provider isolation | Record-oriented Collector Crypt and Courtyard mappers only | PASS |
| Unknown trade events | Canonical `other`, protected raw value retained | PASS |
| Source replay | Fact hash excludes observation time; repeated collection records an observation | PASS |
| Mutable catalog | Stable identity permits fact revisions and canonical history | PASS |
| Immutable events | Conflicting pull/trade facts quarantine instead of revising | PASS |
| Archive isolation | Resumable archive runs never advance the live provider checkpoint | PASS |
| Archive storage | Hash-bound page metadata; each raw record stored once | PASS |
| V1 removal | Repository checker rejects V1 contracts, adapter keys, and paths | PASS |
| Public-data boundary | Raw records, pulls, trades, identities, and cursors excluded from Convex | DESIGN ENFORCED |

PASS here means committed automated behavior after the repository verifier is
green. It does not claim that a target database has imported or reconciled the
archive.

## Import reconciliation

For each target database, record:

- organization, provider, configuration, and archive run IDs;
- exact archive digest and clean importer Git HEAD SHA;
- committed page and source counts by platform and record kind;
- accepted, duplicate, quarantined, and immutable-conflict outcomes;
- canonical pack, catalog asset, pull, and trade counts;
- unresolved relationships caused by the one-day card delta;
- replay result proving no new pages, sources, quarantines, or canonical
  revisions for the same archive digest.

Do not require every pull/trade card relationship to resolve from this archive.
The card files contain changes from one day rather than the initial full
catalog. All pack relationships should resolve.

## Live HTTP launch blockers

Capture one sanitized real response and its headers, then implement the
provider-local decoder and prove:

1. Body serialization and wrapper fields.
2. `nextCursor` and `hasMore` behavior at provider head.
3. Initial null-cursor full-history ordering and incremental continuation.
4. Page-size limits and cursor expiry.
5. Authentication failure, rate limiting, server failure, and malformed-page
   responses.
6. Exact replay, conflicting immutable event, catalog correction, malformed
   record, timeout recovery, and lost-worker recovery.

Only after those checks pass may the V2 HTTP adapter be registered in admin and
worker production composition or a schedule be activated.

## Convex promotion boundary

Convex remains a sanitized frontend read model. It must not receive the archive,
raw provider envelopes, pull/trade events, cursors, wallets, owners, or protected
transaction evidence. Promotion requires a deterministic canonical PostgreSQL
export plus the production batch writer, finalizer, receipts, count/hash
reconciliation, and activation gate described in `docs/convex-data-model.md`.
That publisher is a separate launch gate.

## Verification commands

```bash
npm run check:provider-v2-only
npm run test:contracts
npm run test:database
npm run test:services
npm run test:worker
npm run test:admin
npm run verify:framework
```

The external archive gate accepts an explicit protected archive path and emits
bounded summaries: dry-run counts and digest, or commit run ID, state, replay
status, and counters. It must never print raw provider records.
