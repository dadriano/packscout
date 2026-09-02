# Provider page transaction limits acceptance map

A mixed page must validate every deferred database constraint before its
transaction callback returns. This keeps expensive constraint checks within the
existing query-expiration and settled-rollback boundary. It does not increase
transaction deadlines, change request sizes, weaken constraints, or authorize
retries after uncertain commits.

| Given / When / Then | Coverage |
| --- | --- |
| Given canonical and promotion writes; when an active query or the next query expires; then the exact query-expiration classifier accepts the settled callback error and all writes roll back. | Automated: `provider-page-transaction-limit-matrix.integration.test.ts`. |
| Given a callback that returns after its deadline; when commit is attempted; then the commit-expiration error remains refused by the query classifier. | Automated: the same matrix. |
| Given deferred constraint work running during commit; when the deadline expires; then the error can coexist with durable canonical and promotion writes and must remain refused. | Automated: the same matrix verifies a durable row, promotion, and ledger advancement despite an expired-commit error. |
| Given the same deferred work executed inside the callback; when it expires; then the query classifier accepts the settled rollback and no writes remain. | Automated: the same matrix. |
| Given a complete mixed page with a category, pull and item, canonical quarantine, source quarantine, and activity outboxes; when the first deferred check expires; then the existing single retry starts from the unchanged page state and commits every effect exactly once. | Automated: `provider-mixed-page-constraint-boundary.integration.test.ts`. |
| Given the same page; when both bounded attempts expire; then the existing typed expiration is returned and runtime, checkpoint, page counters, canonical facts, promotions, quarantines, and outboxes remain unchanged. | Automated: the same mixed-page test. |
| Given a successfully retried page; when its identical page receipt is replayed; then all stored state and counters remain unchanged. | Automated: the same mixed-page test. |

The tests use explicitly selected disposable PostgreSQL 16 databases. Their
synthetic deferred sleep triggers and shorter test transaction deadlines never
enter production migrations or transaction configuration. The matrix logs only
fixed subtype labels, timing, error-identity booleans, and durable row counts.

The Collector incident's retained diagnostic was only `page_commit` /
`transaction_invalid`; timing alone does not prove its exact Prisma subtype.
This change mitigates the independently reproduced commit-boundary hazard. It
does not establish a throughput improvement or make all possible commit failures
safe to retry. The canonical handoff gate remains `npm run verify:framework`.
