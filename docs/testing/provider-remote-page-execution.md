# Remote provider page execution

The worker commits one normalized source page atomically. A remote PostgreSQL
round trip can make a valid page exceed the local transaction window even when
the source HTTP response is quick. Runtime mode selects finite execution and
request resource budgets without changing provider configuration, cursor identity,
adapter versions, or schema.

| Bound | Local | Remote |
| --- | --- | --- |
| Maximum page transaction | 30 seconds | 480 seconds |
| Whole page window, including source read | 55 seconds | 540 seconds |
| Routed gateway operation | 60 seconds | 600 seconds |
| Default import lease | 300 seconds | 900 seconds |
| Source records per request | Adapter maximum | Smaller of 100 and adapter maximum |

The remote manual importer applies the source-record ceiling through the
adapter's existing per-operation bounds. It does not rewrite the immutable
manifest or use provider-specific branches. For example, Collector Crypt keeps
its 1,000-record manifest and exact saved cursor envelope while a remote request
uses `limit=100`. Local requests retain the manifest maximum. The same effective
bound governs request admission, HTTP query, audit scope, response interpretation,
and terminalization. A response containing 101 records for a 100-record request
is rejected before canonical translation; the transport attempt remains audited.
Response-byte and source-timeout limits are unchanged. No page is sliced or
discarded locally: only the source's returned continuation advances the cursor.

The smaller remote request bounds sequential pull and event writes, which do
not use collectible batching. At the observed approximately 46 ms warm Neon
round trip, a 1,000-pull page's minimum 8,000 operations could consume most of
the 480-second transaction window before constraints or additional lookups.
This estimate motivates the ceiling; it does not substitute for a durable first
page and subsequent progress after launch.

The gateway requires an explicit `atomic_import_page` profile to allow an
operation over 60 seconds. Standard callers retain their previous bounds.
Connection, cache, provider identity, credential and TLS checks remain unchanged.
Remote workers reject custom leases shorter than the gateway budget plus a
60-second reserve. Before an extended page transaction writes, its locked lease
must have enough time remaining according to the database clock for that
transaction and its final validation. Transaction attempts are clipped to the
remaining page window and reserve time for connection acquisition and settlement.

Only the existing positively identified expired-query rejection inside a rolled
back callback may receive one sequential retry. Unknown `P2028` errors and commit
acknowledgement failures do not authorize retries. Deferred constraints are
validated inside the callback before it returns. A larger timeout does not prove
that a particular page will complete; actual committed-page receipts and source
head reconciliation must establish that after deployment.

Longer atomic pages hold their locks longer and may delay graceful operator
Pause while the page drains. Never kill a live page to meet a progress reporting
deadline or steal its lease. An outer gateway timeout is not cancellation of its
callback: the worker drains its owned callback before closing either database
lifecycle. A hung external dependency remains an incident requiring inspection,
not permission to start a duplicate worker.

| Acceptance behavior | Evidence |
| --- | --- |
| Remote bounds nest inside the lease; invalid modes/short leases refuse before I/O | `apps/worker/src/provider-manual-import-execution-budget.test.ts` |
| Remote requests use 100 with the unchanged opaque cursor, canonical order and manifest; local uses 1,000; 101 records refuse before translation | `apps/worker/src/provider-dataforrest-mixed-page-source.test.ts` |
| Invalid source ceilings refuse before I/O; a ceiling cannot increase a smaller manifest maximum | `apps/worker/src/provider-dataforrest-mixed-page-source.test.ts` |
| Explicit atomic opt-in preserves destination authorization and standard bounds | `packages/database/src/provider-database-gateway.test.ts` |
| Attempts are clipped and unknown/commit errors are never retried | `packages/database/src/provider-page-transaction.test.ts` |
| Source quarantine batching and extended first-attempt lease reserve remain atomic | `packages/database/src/provider-quarantine-batch.integration.test.ts` |
| Outer timeout cannot close resources ahead of the callback | `apps/worker/src/provider-manual-import-operation-drain.test.ts` |
| Durable live page, reconciliation and subsequent polling | Private maintenance operation proofs; not inferred from unit tests |
