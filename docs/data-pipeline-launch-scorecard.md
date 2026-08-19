# Data Pipeline Launch Scorecard

**Evidence date:** 2026-08-19

**Provider record contract:** PASS for the August 13 archive

**Archive import:** IMPLEMENTED; database reconciliation required per target

**Live HTTP transport:** PASS for the observed DataForrest wrapper

**Scheduled provider launch:** BLOCKED on complete mapper, database, and
capacity reconciliation

## Current boundary

The production data pipeline uses `ProviderStreamContractV2`. Aggregate V1
pages and `http-cursor-v1` have been removed; there is no dual read, alias, or
compatibility path.

V2 separates two facts:

1. The August 13 archive proves every record envelope and the Collector Crypt
   and Courtyard nested mapping shapes.
2. A sanitized August 19 live inspection proves the DataForrest JSON wrapper,
   platform-scoped cursors, terminal poll signal, bearer failures, and the four
   current platforms. It does not make the older sample database compatible
   with normalized live history.

The common HTTP adapter accepts a provider-local response decoder. The
DataForrest decoder is registered in admin and worker composition. It maps
`records`, `next_cursor`, and `poll_after_seconds` to an internal page using one
platform-scoped provider cursor and mixed catalog, pull, and trade records.

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
| Provider isolation | Record-oriented mapper selected for each platform record | IN REVIEW |
| Unknown trade events | Canonical `other`, protected raw value retained | PASS |
| Source replay | Fact hash excludes observation time; repeated collection records an observation | PASS |
| Mutable catalog | Stable identity permits fact revisions and canonical history | PASS |
| Immutable events | Conflicting pull/trade facts quarantine instead of revising | PASS |
| Archive isolation | Resumable archive runs never advance the live provider checkpoint | PASS |
| Archive storage | Hash-bound page metadata; each raw record stored once | PASS |
| V1 removal | Repository checker rejects V1 contracts, adapter keys, and paths | PASS |
| Public-data boundary | Raw records, pulls, trades, identities, and cursors excluded from Convex | DESIGN ENFORCED |
| Live wrapper | Strict DataForrest decoder and platform-scoped cursor transport | PASS |
| Live page bound | Explicit 10 MiB cap covers observed default pages | PASS |

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

The wrapper and transport are implemented. Before a scheduled full-history run:

1. Finish and verify conservative V2 mapping for Courtyard, Collector Crypt,
   Phygitals, and ClutchPacks.
2. Preserve the August 13 sample as dated evidence and provision a clean live
   database/source namespace. Do not attach live revisions to archive providers.
3. Provision enough storage for roughly 14.5 million records plus indexes, WAL,
   and recovery headroom. The current generic source-and-canonical layout must
   be measured before using a local disk near capacity.
4. Run connection tests for all four immutable HTTP revisions without logging
   credential or record evidence.
5. Prove cursor-expiry, rate-limit, transient-server-failure, timeout, and
   lost-worker recovery with the production decoder.
6. Reconcile source, outcome, canonical, relationship, quarantine, and provider
   head counts, then prove an incremental head replay is a no-op.

Only after those checks pass may a schedule be activated.

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
