# Provider Data Contract V2

**Status:** approved record contract and observed live HTTP transport
**Evidence date:** 2026-08-19 UTC

## Evidence boundary

V2 is grounded in `packscout_sample_2026-08-13.zip` (SHA-256
`cf1306ebfc449aed187457660dd3c374afde1b4520c2f93d09718129ecfb08f8`).
The archive contains 317,697 newline-delimited JSON records from Collector Crypt
and Courtyard. It proves the original record envelopes and those two provider
payload shapes. A sanitized live API inspection on August 19 additionally
proved the response wrapper, platform-scoped cursor behavior, terminal polling
signal, authentication failures, and the live `available` and
`payment_method` fields. The credential itself is never fixture or log data.

| Platform | Catalog | Pulls | Trades | Total |
| --- | ---: | ---: | ---: | ---: |
| Collector Crypt | 56,962 | 35,266 | 1,060 | 93,288 |
| Courtyard | 57,784 | 49,373 | 117,252 | 224,409 |
| **Total** | **114,746** | **84,639** | **118,312** | **317,697** |

Every archive identity is unique by `(platform, stream, record_id)`. All
317,697 records satisfy the V2 envelope when a pull's `card_id` is explicitly
nullable. Exactly 9,844 Collector Crypt pulls have no card outcome; those are
valid incomplete observations, not fabricated cards or discarded input.

## Record envelope

All records contain:

- `stream`: `catalog`, `pulls`, or `trades`
- `platform`
- `record_id`
- nullable `occurred_at`
- `collected_at`
- opaque provider-owned `data`

Catalog records also contain `entity` (`pack` or `card`), `first_seen_at`, and
live availability (`boolean` for packs and `null` for cards). Archive records
predating that field remain valid only through the digest-bound archive path.
Pulls contain `pack_id` and nullable `card_id`. Trades contain `card_id`, raw
`event_type`, nullable `amount`, nullable `currency`, nullable
`payment_method`, and `tx_hash`.

Outer identities and relationships are authoritative. A provider-local mapper
may read nested data for canonical fields, but nested lookalike IDs cannot
override the outer envelope.

## Cursor and page contract

PackScout maintains one opaque cursor for each immutable provider
configuration revision. A normalized internal page may interleave all three
streams in provider order:

```text
ProviderPageV2 {
  requestedCursor: string | null
  nextCursor: non-empty string
  hasMore: boolean
  records: ProviderRecordV2[]
}
```

The next cursor is required even at provider head so the next scheduled import
can resume rather than restart full history. Continuing pages must contain a
record and advance to a cursor not previously seen in the run. Cursors are
opaque, limited to 2,048 characters, and never parsed for product meaning.

The DataForrest HTTP client sends `platform` and, after a checkpoint exists,
`cursor`. It does not send a stream selector. The cursor is bound to the
platform filter. The observed response is:

```text
{
  records: ProviderRecordV2[]
  next_cursor: string
  poll_after_seconds: number
}
```

`poll_after_seconds === 0` means another page is immediately available. A
positive value means the provider is at head, so the normalized page uses
`hasMore: false` while retaining `next_cursor` as the durable checkpoint.

The production decoder validates the wrapper before producing the normalized
page. Default 500-record responses observed between roughly 0.6 MiB and 3.1 MiB
across the four platforms. Live connection tests and imports therefore retain
an explicit 10 MiB response limit; they do not rely on the common adapter's
smaller fallback.

## Mapping decisions

- Unknown raw trade event types normalize to `other`. The exact value remains
  in protected source evidence; a bounded, whitespace-normalized provider value
  remains in protected canonical PostgreSQL evidence. Neither is publicly
  promoted.
- Canonical lifecycle values are `sale`, `buyback`, `mint`, `burn`, `transfer`,
  `list`, `unlist`, `swap`, `ship`, and `other`.
- Collector Crypt amounts identified as USDC remain USDC. Courtyard's approved
  token address normalizes to USDC. The provider confirmed Courtyard settlement
  is USDC, so raw `stripe` and `partial_payment` values retain USDC money while
  moving to payment method instead of being treated as currency identifiers.
- Canonical money carries an explicit minor-unit exponent: `2` for USD and `6`
  for USDC. Non-cent USDC amounts therefore retain their source precision.
- Provider-reported EV remains separate from PackScout Estimated EV.
- Incomplete odds or inventory keep a pack visible with an unavailable
  PackScout estimate. Bucket midpoints are not represented as true EV.
- Source payloads, wallets, owners, transaction evidence, and raw identities
  remain in protected PostgreSQL evidence and are never copied to Convex.

## Persistence rules

- Catalog identities are mutable: a changed fact set creates a canonical
  revision when stable identity fields still agree.
- Pulls and trades are immutable: an exact replay records another observation;
  conflicting facts for the same identity are quarantined and never projected.
- `collected_at` is observation metadata and is excluded from fact hashes.
- A mixed page commits source evidence, outcomes, canonical revisions,
  relationships, and the single cursor advancement atomically.
- Archive imports use a separate resumable operation and do not advance the
  live provider checkpoint. Page rows retain only hash-bound archive metadata;
  each raw record payload is stored once.
- Live DataForrest page rows retain a body digest, count, next cursor, and poll
  interval rather than duplicating every record payload. Each source record is
  still retained as protected evidence.

## Remaining launch evidence

Before activating a full-history import, complete and reconcile:

- provider mapping coverage for all four registered platforms;
- clean-database bootstrap and resumable full-history execution;
- storage capacity for the approximately 14.5 million-record history;
- transient failure, cursor expiry, and sustained rate-limit behavior;
- exact source/canonical counts and a no-op replay at provider head.

The August 13 sample database is not a valid live-import target. Live history
adds normalized event, currency, payment-method, and availability facts, so an
overlapping immutable event may correctly differ from its archive-era record.
Keep the sample as dated evidence and use a clean live source namespace.
