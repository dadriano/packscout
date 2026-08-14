# Provider Data Contract V2

**Status:** approved record contract; live HTTP wrapper pending evidence
**Evidence date:** 2026-08-13 UTC

## Evidence boundary

V2 is grounded in `packscout_sample_2026-08-13.zip` (SHA-256
`cf1306ebfc449aed187457660dd3c374afde1b4520c2f93d09718129ecfb08f8`).
The archive contains 317,697 newline-delimited JSON records from Collector Crypt
and Courtyard. It proves the record envelopes and provider payload shapes. It
does not prove the live API response wrapper, headers, error body, rate-limit
signals, or terminal cursor field.

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

Catalog records also contain `entity` (`pack` or `card`) and `first_seen_at`.
Pulls contain `pack_id` and nullable `card_id`. Trades contain `card_id`, raw
`event_type`, nullable `amount`, nullable `currency`, and `tx_hash`.

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

The common HTTP client sends `platform` and, after a checkpoint exists,
`cursor`. It does not send a stream selector. A provider-local response decoder
owns body serialization and raw wrapper interpretation before producing the
normalized page above. No production decoder is registered until one sanitized
live response establishes that wrapper.

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

## Remaining live-API evidence

Before activating scheduled HTTP imports, capture and sanitize one real page
and its headers to lock:

- response serialization and wrapper fields;
- terminal cursor and `hasMore` behavior;
- initial full-history and incremental ordering;
- page-size and cursor-expiry rules;
- authentication, error, and rate-limit responses.

If those facts differ, update only the provider-local decoder unless they
invalidate the normalized one-cursor page contract.
