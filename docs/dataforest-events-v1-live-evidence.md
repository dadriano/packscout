# DataForrest Events V1 Live Evidence

**Evidence window:** 2026-08-20 21:36–21:38 America/Los_Angeles

**Endpoint:** `https://198.204.245.26.sslip.io/v1/events`

**Reviewer:** PackScout engineering (automated structural capture plus manual contract review)

**Verdict:** PASS for tasks 002–009; the real local backfill remains capacity-blocked. The measured Task 010 admission requirement is 8,757,364,735,856 available bytes, and this host is explicitly rejected.

## Safety boundary

The fixed-endpoint capture command reads `PACKSCOUT_DATA_API_TOKEN` from its
environment, removes the process copy before requests begin, rejects redirects,
and emits structure, booleans, counts, statuses, byte counts, and timings only.
The reviewed report contained no authorization value, cursor value, provider
record identity, transaction identity, wallet, username, or provider payload
value. Raw response hashes were used only in memory to compare same-cursor
replays and were not emitted. Protected responses and the guide export were held
in mode-`0600` files under `/private/tmp` during review and are not repository
artifacts.

The reproducible command and safety checks are documented in
[`dataforest-live-evidence-capture.md`](./dataforest-live-evidence-capture.md).
CI uses the offline capture tests and never needs the live credential.

The committed synthetic structural fixture is
[`dataforest-events-v1.fixture.ts`](../packages/contracts/src/__fixtures__/dataforest-events-v1.fixture.ts).
Its reviewed SHA-256 is
`a4c3177889f68805d396aa24cbf512669f6b323cd4eb7d7eb60f7272594a29e1`.
It uses ordinal aliases while preserving wrapper fields, types, nulls,
relationships, replay identity, catalog revision, and reached-head shape.

## Frozen launch bounds

| Setting | Launch value | Evidence |
| --- | ---: | --- |
| Filtered page target | 250 records | A 500-record Phygitals response advertised 3,114,066 bytes and was rejected by the 2 MiB cap. Two 250-record Phygitals pages were 1,415,669 and 1,698,526 bytes. |
| Maximum response | 2,097,152 bytes | Every reviewed 250-record page fit. The capture rejected the oversized 500-record response before reading its body. |
| Request timeout | 10,000 ms | Fourteen successful filtered requests ranged from 435 to 4,042 ms, averaging 1,728 ms. |
| Stable-profile request cap | 2 | Two different filters overlapped in the client, both returned 200, both remained filter-correct, and their cursors were independent. A higher value was not tested. |
| Generic execution slots | 4 | Host-local processing bound; connection requests remain capped separately at two. |
| Source interval | 60–86,400 seconds; default 60 | Product decision. A positive provider hint is a minimum, so scheduling uses `max(source interval, provider minimum)`. |
| Raw page retention | 7 days | One authoritative protected copy only. |
| Quarantine, diagnostics, terminal attempts | 30 days | Protected quarantine remains independently retryable; diagnostics and attempts are sanitized. |

The provider supports a maximum requested limit of 5,000, but PackScout does
not use that limit. The live launch bound is 250 because response bytes, rather
than record count alone, bound memory and transport risk.

## Live request and cursor evidence

The profile-only connection probe sent no platform, cursor, source, run, or page
state and returned 200 with the documented wrapper. Each filtered probe sent
only `platform`, `limit`, and, for continuation, the prior opaque cursor.

| Filter | Initial bytes | Continuation bytes | Initial/continuation records | Filter mismatches | Same-cursor replay |
| --- | ---: | ---: | ---: | ---: | --- |
| `courtyard` | 413,503 | 413,243 | 250 / 250 | 0 | Exact ordered record identities and next-cursor relationship |
| `collector_crypt` | 271,589 | 264,298 | 250 / 250 | 0 | Exact ordered record identities and next-cursor relationship |
| `phygitals` | 1,415,669 | 1,698,526 | 250 / 250 | 0 | Exact ordered record identities and next-cursor relationship |
| `clutchpacks` | 331,329 | 331,312 | 250 / 250 | 0 | Exact ordered record identities and next-cursor relationship |

All eight pages returned `poll_after_seconds = 0`, a nonblank next cursor, and
only records for the requested filter. Repeating a saved continuation request
after reconstructing the client returned the same ordered 250 record identities
and next-cursor relationship for every filter. Supplying each filter's cursor to
the next filter returned 400. A malformed cursor and unknown filter also
returned 400. Missing authentication returned 401.

The capture observed two concurrent requests in flight. Courtyard and Collector
Crypt completed successfully in a combined 812 ms wall window with no filter or
cursor contamination. This freezes a conservative aggregate connection-profile
cap of two; four execution lanes may still map and persist already captured
pages independently.

## Page and record contract

The live wrapper has exactly `records`, `next_cursor`, and
`poll_after_seconds`. The cursor is an opaque nonblank string. Generic code may
store, bound, fingerprint, and compare it but may not parse or move it between
source instances. DataForrest alone maps a zero poll hint to `continue` and a
positive integer to `poll_after(minimumDelaySeconds)`; the guide documents 60 as
the reached-head hint.

The 2,000 live records inspected across initial and continuation pages had these
outer field types:

| Field | Observed type | Meaning |
| --- | --- | --- |
| `stream` | string | `catalog`, `pulls`, or `trades` per provider guide |
| `platform` | string | Must equal the immutable source filter |
| `record_id` | string | Provider record identity; never replaced with `tx_hash` |
| `occurred_at` | string | Effective provider time |
| `collected_at` | string | DataForrest collection time |
| `data` | object | Protected provider-native evidence; generic code does not interpret it |
| `entity` | string on catalog | `pack` or `card` |
| `first_seen_at` | string on catalog | Initial catalog observation time |
| `available` | boolean or null on catalog | Pack availability; card values are nullable |
| `pack_id`, `card_id` | string where applicable | Scope-qualified relationship IDs |
| `event_type` | string on trades | Provider's normalized nine-code vocabulary |
| `amount` | number or null on trades | Amount without a fabricated zero |
| `currency` | string or null on trades | Ticker only |
| `payment_method` | string or null on trades | Separate payment method; historical pages may be null |
| `tx_hash` | string in observed trades | Evidence only, not source identity |

The provider guide freezes event codes `sale`, `buyback`, `mint`, `burn`,
`transfer`, `list`, `unlist`, `swap`, and `ship`; unrecognized values remain
explicitly unrecognized rather than being guessed. It documents `available =
true` as in rotation, `false` as unavailable for any sold-out/hidden/removed
reason, and `null` as unreported. Therefore DataForrest never supplies an
authoritative `sold_out` state: false normalizes to `unavailable`, not
`sold_out`.

## Identity and normalized translation

The provider guide states that `record_id` is stable across polls, delivery is
at least once, and the persistence key is platform plus `record_id`. The live
same-cursor replays confirmed stability at every inspected position. Long-term
global uniqueness is provider-documented rather than inferred from this bounded
sample.

PackScout still freezes one semantic record-ID scope per launch shape so a
relationship and canonical domain remain unambiguous:

| DataForrest shape | `recordIdScopeKey` | Normalized kind | Relationship targets | Canonical kind |
| --- | --- | --- | --- | --- |
| `catalog` + `pack` | `catalog-pack-v1` | catalog pack | none from outer envelope | `pack` |
| `catalog` + `card` | `catalog-card-v1` | catalog card | none from outer envelope | `catalog_asset` with card subtype |
| `pulls` | `pull-v1` | pull | `pack_id` → `catalog-pack-v1`; `card_id` → `catalog-card-v1` | `pull` |
| `trades` | `trade-v1` | trade | `card_id` → `catalog-card-v1` | `market_event` |

This mapping is injective from scope to canonical kind. Equal raw IDs in
different evidenced scopes remain distinct; a kind or pack/card discriminator
change inside one scope is an identity conflict. Each platform uses a separate
`dataforrest-<platform>-records-v1` replacement namespace. A future PackScout or
third-party adapter may reuse the platform mapper and canonical identities only
after proving it emits the same IDs, scopes, and namespace; otherwise activation
must stop for a separately designed identity migration.

The adapter copies the two timestamps, outer relationships, event code, amount,
currency, payment method, and tri-state availability into the versioned
normalized observation. From native `data`, it allowlists only the evidenced
nonblank `provider_label` as the source-neutral display-name fact; missing or
malformed labels remain explicit and every other nested key stays protected
provenance. The mapper never receives the native object, and the adapter does
not apply provider-specific canonical rules.

## Failure contract

| Condition | Evidence class | Runtime class |
| --- | --- | --- |
| Missing or wrong bearer | Live/documented 401 | Connection-scoped action required; one blocking episode |
| Unknown filter, malformed cursor, or cursor/filter mismatch | Live/documented 400 | Source/configuration action required; do not retry unchanged input |
| Client timeout or network interruption | Client-bound behavior | Retryable with the same requested checkpoint |
| Provider 500 | Provider documented | Retryable with the same requested checkpoint |
| Provider 429 / rate headers | Unavailable; not naturally observed | Do not invent semantics; preserve safe status evidence and use conservative retry handling if observed |
| HTTP redirect | Provider documents HTTP→HTTPS 301 | Runtime sends HTTPS only and rejects redirects/destination changes |

No harmful load or manufactured provider failure was used.

## Capacity and memory gate

The announced dated baseline is 14,526,877 records. At 250 records per page it
requires about 58,108 pages. The eight reviewed pages averaged 642,434 bytes
(2,570 bytes per record), which extrapolates to 37.3 GB for one raw full-history
copy. The largest reviewed page extrapolates to a conservative 98.7 GB raw
window.

Task 006 measured 72 representative final-schema commits across three
independent 24-page windows: 288 input records, 216 accepted records, and 72
quarantined records. Every retained component uses a PostgreSQL physical
table/index/TOAST slope. The committed bound adds one measured 8 KiB allocation
page per affected relation instead of an arbitrary multiplier. This produces
11,520 structured/canonical bytes per input record, 2,640 bytes per record for
the seven-day normalized payload, 9,217 bytes per permanently retained expired
page lineage, and separately measured quarantine lineage/evidence. The complete
machine-readable artifact is
[`provider-source-capacity-measurement-v1.json`](./provider-source-capacity-measurement-v1.json).

No observed steady-state delivery rate is available. The forecast therefore
fails closed at the transport maximum: every one of the four sources returns a
full 250-record page on every 60-second poll throughout the 365-day growth
horizon. That budgets 525,600,000 incremental records permanently, plus
10,080,000 incremental records in the rolling seven-day payload window and
43,200,000 in the rolling 30-day quarantine window. This is an admission upper
bound, not a claim about likely provider volume; replacing it requires new
reviewed evidence and a regenerated versioned artifact.

The forecast retains one conservative full-history raw copy, seven days of
steady-poll raw pages, seven-day normalized payload, permanent expired page
lineage, 30 days of representative quarantine evidence, page diagnostics,
30-day terminal request attempts, and permanent compact attempt lineage. Raw
response bytes are excluded from the normalized-payload slope and modeled only
in the raw windows; quarantine uses the larger of measured evidence payload and
the reviewed raw-record average, so no retained payload category is counted
twice. It projects:

| Component | Projected bytes |
| --- | ---: |
| Structured and canonical data | 6,222,261,623,040 |
| Conservative raw full history | 98,700,000,000 |
| Seven-day steady-poll raw pages | 25,902,938,880 |
| Seven-day normalized page payload | 64,962,155,280 |
| Permanent expired page lineage | 19,913,402,236 |
| Quarantine lineage and evidence | 120,851,217,000 |
| Page diagnostics | 473,130,492 |
| Terminal request attempts | 946,030,076 |
| Permanent compact attempt lineage | 14,013,054,888 |
| **Total** | **6,568,023,551,892** |

At a 60-second interval, four sources create 172,800 poll attempts in 30 days;
including the 58,108 initial pages gives 230,908 first-window attempts. Leaving
25% of the target volume free after the projected import requires
**8,757,364,735,856 available bytes** before Task 010 may start. The 200 GB
provisional floor is therefore superseded by this measured requirement. The
80%-used abort threshold remains independently enforced.

The committed host measurement reported 994,662,584,320 bytes of capacity and
only 25,755,877,376 available bytes. Admission was rejected for insufficient
free bytes, an already-exceeded 80% threshold, and a projected threshold
breach. Task 010 must not start a real backfill on this host. This does not block
contract, adapter, mapper, importer, scheduler, admin, or UI implementation.

The bounded-memory benchmark processed 10 warm-up pages and five 20-page trials
(100 measured pages total), each exactly 250 records and 2 MiB, through the
authentic capture, durable-terminalization acknowledgement, interpretation,
deep immutable completion, import validation, mapping, planning, and discard
path. Peak RSS rose 27,557,888 bytes. The allocator-tolerant Theil–Sen trend over
settled heap-plus-external samples projected only 162,600 retained bytes across
100 pages, within the 64 MiB peak and 8 MiB retained limits. Four execution
slots therefore reserve at most 256 MiB of page-working-set budget before normal
process overhead.

Reproduction and drift checks are executable from the repository root:

```bash
# Regenerate the complete machine-readable storage, memory, forecast, and host
# admission artifact to stdout (the npm alias runs this same command).
node --import tsx scripts/local/generate-provider-source-capacity-artifact.mts

# Re-measure every committed relation (logical row, table, index, and TOAST)
# and independently compare the invariant values with the JSON artifact.
PACKSCOUT_PRINT_PROVIDER_SOURCE_CAPACITY=1 node --import tsx --test \
  --test-name-pattern='representative mixed commit measures' \
  packages/services/src/provider-source-atomic-page.integration.test.ts

# Regenerate the authentic bounded 100-page memory measurement.
npm run measure:provider-source-page-memory:local

# Recompute every forecast value and verify the committed admission decision.
node --import tsx --test \
  packages/services/src/provider-source-capacity-preflight.test.ts

# Read the target volume and make the live Task 010 admission decision.
npm run preflight:provider-source-backfill:local -- \
  --database-path <postgres-data-volume-path> \
  --unreconciled-attempts <count>
```

The measured page duration in the artifact is an observed performance sample,
not a deterministic invariant; the storage command emits a fresh duration on
every run. Relation sizes, row counts, statement count, forecast values, memory
limits, and the committed host decision are independently asserted by the named
tests, so the JSON cannot silently drift as a hand-edited estimate.

## Fact classification

| Fact | Classification |
| --- | --- |
| HTTPS GET, bearer header, optional platform/cursor/limit, wrapper, field types, four filter values | Live observed and provider documented |
| Filter-bound cursor, same-cursor replay, at-least-once delivery | Live observed; delivery guarantee also provider documented |
| Zero means backlog; positive 60 means reached head | Provider documented; zero live observed |
| Nine event codes and native wording retained under `data` | Provider documented |
| Currency/payment split and tri-state availability | Live shape observed and provider documented |
| Stable platform + `record_id` identity | Provider documented; bounded replay observed |
| Complete long-term cross-scope collision absence | Unavailable; PackScout uses explicit scope keys and fails closed on in-scope discriminator change |
| Rate-limit threshold and headers | Unavailable; cap remains two |
| Provider 500 body shape | Unavailable; only retry class is documented |
| End-to-end full-history time and database size | Unavailable until task 010; provider's one-to-two-hour statement is not a PackScout SLO |
