# ClutchPacks production source reader

`scripts/live/clutchpacks-production-source-reader.mts` exports a lazy factory,
`createClutchpacksProductionSourceReader(options)`. It reads no environment files,
contacts no upstream source or Convex service, changes no schema, and installs no
credentials. The caller supplies the exact central URL, two distinct Neon hosts,
credential resolver, organization/provider/operator/configuration pins, reviewed
runtime generation/version, succeeded source-head run, checkpoint hash, full
route digest and approved public image origins. The caller owns the credential
resolver's lifetime and secret disposal; this reader drains and closes its own
database clients. It makes no claim to zeroize JavaScript strings or caller keys.

Only direct port5432 with verified TLS is admitted: `verify-full` or its native
Prisma equivalent `require&sslaccept=strict`. Duplicate/alternate connection
parameters, loopback, unapproved hosts and database names are refused. Existing
local utilities and their guards are unchanged.

## Caller sequence

1. Call `read()` for a complete dry snapshot. It never acquires a lease and refuses
   every owned import lease, including an expired owner requiring inspection.
2. Only when separately authorized to publish, call `leasePort.acquire` with a
   unique publication owner and role `import`. It uses the normal fenced lease
   repository. A first complete read is required before acquisition.
3. Serialize `read`, `assertQuiet`, `renew` and `release`; overlapping operations
   fail closed. Use full `read({expectedImportLease})` before the first public
   write, before activation and for final verification. Between batches use
   `assertQuiet({expectedImportLease})` and normal renewal. `assertQuiet` reads
   fresh authority/head/runtime/checkpoint/reconciliation/promotion-ledger
   metadata, never the full collectible catalog; it is not a fresh catalog scan.
4. Release the exact lease explicitly, then `close()`. Factory/read/close never
   release or mutate a lease implicitly. A known successful acquisition whose
   post-check fails attempts compensation only after fresh exact central
   authority, provider identity and owner/fence proof, through normal release.
   Unprovable or uncertain cleanup returns
   `PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED`. An acquire timeout without a
   returned lease remains uncertain: no invented success, retry or forced clear.
   Preserve the requested owner and operation evidence for inspection/normal
   expiry. An error must stop publication.

## Returned source facts

`read()` returns `facts`, `canonicalCatalog`, `sourceCheckpoint`,
`sourceObservation` and `stabilityFingerprint`. No local shared-configuration
epoch, public identity, release builder or provisional public plan is returned.

`facts` retains the established pack/content evidence shape. Its
`activeImportLeaseCount` means competing import leases: an exact validated
publication lease is excluded. `canonicalCatalog.collectibles` contains **all
active collectibles**, not only membership cards; `aliases` contains active
aliases belonging to those cards. Packs and cards preserve their actual
`category_id`; categories preserve IDs, keys, names, parents and lifecycle.
Categories include retired ancestors for reference completeness, which is not
permission to publish them as active categories. All rows use canonical Prisma
field names and Date/bigint/Decimal values. No account rows or raw source payloads
are read. Fixed bounds fail rather than truncate: 5,000 categories/packs, 20,000
active collectibles, 50,000 active aliases; retained membership limits remain
5,000. Image origins are validated without fetching images; listing URLs are
validated as credential-free HTTPS source facts.

`sourceObservation` reports stored operating/quality/freshness states,
last-head time, schedule/next-due time, and the latest run's quarantine count.
Quality is not inferred from quarantine counts. The source checkpoint binds
the exact run/version, full cursor hash, runtime generation/version,
configuration, own head page, completed reconciliation receipt and ledger.
Only a succeeded own-page head is supported; recovery ancestry is not guessed.

The full fingerprint covers all source facts, aliases, categories, canonical
rows, retained evidence/readiness inputs and scoped authority. Fresh central
authority is checked before and after provider snapshots, followed by a fresh
provider transaction to detect changes hidden by RepeatableRead. Provider-clock
lease admission retains at least15seconds of budget after the final awaited
authority read. Read-only transactions use a10second statement bound and30second
transaction bound. The public transaction-drain helper preserves original
timeout errors while waiting for callbacks before resource closure; the three
normal lease repository transactions use that same helper without changing SQL,
fences, isolation or return values.

## Acceptance map

| Behavior | Regression coverage |
| --- | --- |
| Strict TLS, exact URL/scope, no constructor credential call | `scripts/live/clutchpacks-production-source-reader.test.mjs` |
| Real PostgreSQL read-only enforcement, tenant/operator/config/route/identity/head/checkpoint rejection, full nonmembership catalog, unchanged dry history, normal lease exclusion, exact cleanup and short-budget refusal | `scripts/live/clutchpacks-production-source-reader.test.mjs` |
| Frozen pins, full-read/cheap-read separation, post-snapshot drift, delayed final authority, single-flight/draining close, redaction, compensation and captured requests | `scripts/live/clutchpacks-production-source-controller.test.mjs` |
| Known versus uncertain acquire, exact compensation, unprovable cleanup, immutable lease request | `scripts/live/clutchpacks-production-source-lease.test.mjs` |
| Actual normal lease callbacks drain after timeout while preserving original error/options | `packages/database/src/drained-database-transaction.test.ts` |

Focused tests create only a new private socket-only PostgreSQL fixture, migrate
its empty databases and tear it down. Synthetic activation/source-head receipts
are fixture data, never evidence of real upstream requests. The assembled
production publisher still requires the unchanged `npm run verify:framework`
gate and its own production-target/authority/publication review.
