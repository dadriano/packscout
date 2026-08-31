# Remote provider page execution

The worker commits one normalized source page atomically. A remote PostgreSQL
round trip can make a valid page exceed the local transaction window even when
the source HTTP response is quick. Runtime mode selects a finite execution
budget; it does not change the source request size, cursor, or schema.

| Bound | Local | Remote |
| --- | --- | --- |
| Maximum page transaction | 30 seconds | 480 seconds |
| Whole page window, including source read | 55 seconds | 540 seconds |
| Routed gateway operation | 60 seconds | 600 seconds |
| Default import lease | 300 seconds | 900 seconds |

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
| Explicit atomic opt-in preserves destination authorization and standard bounds | `packages/database/src/provider-database-gateway.test.ts` |
| Attempts are clipped and unknown/commit errors are never retried | `packages/database/src/provider-page-transaction.test.ts` |
| Source quarantine batching and extended first-attempt lease reserve remain atomic | `packages/database/src/provider-quarantine-batch.integration.test.ts` |
| Outer timeout cannot close resources ahead of the callback | `apps/worker/src/provider-manual-import-operation-drain.test.ts` |
| Durable live page, reconciliation and subsequent polling | Private maintenance operation proofs; not inferred from unit tests |
