# Mixed-page quarantine batching acceptance map

Within the existing provider identity, configuration, cursor and import-lease fences,
a validated page prefetches its unique source-rejection keys once (at most 4,000).
Records retain their input order and canonical savepoints. New quarantines and
validated activity rows are inserted in groups of at most 100, without ignoring
conflicts. The page retains its existing 2,000-quarantine limit and one atomic
checkpoint, receipt, counters, canonical facts and promotion ledger transaction.

| Given / When / Then | Coverage |
| --- | --- |
| Given earlier and same-page source keys plus failed and valid canonical records; when a page spans two insert groups; then prior rows remain unchanged, duplicates count once, canonical savepoints remain effective, and receipt IDs retain source order. | `provider-quarantine-batch.integration.test.ts` |
| Given 103 new quarantines; when persistence runs; then one bounded key lookup and two paired bulk operations replace individual reads/inserts, with one digest-bound, correctly linked activity per quarantine. | The same real PostgreSQL test observes the actual Prisma operations and verifies persisted fields and digests. |
| Given earlier successful insert groups and canonical/promotional work; when a later outbox group fails; then every page effect rolls back and no unknown-error retry is admitted. | The same integration test uses a test-only PostgreSQL trigger. |
| Given foreign provider identity or an extended page budget exceeding the remaining database-clock lease; when commit is requested; then it refuses before quarantine reads or writes. The ordinary local budget remains accepted. | The same integration test. |
| Given protected, malformed or unbounded activity evidence; when either persistence path builds it; then the shared validator rejects it before writes without exposing values. | `provider-local-evidence.test.ts` |
| Given incomplete source-quarantine details or an oversized input; when the prefetch helper runs; then no database read occurs. | The same unit test. |
| Given expensive deferred constraints; when the final callback check expires; then the entire page rolls back before the existing bounded retry. Expired commit acknowledgements remain refused. | `provider-mixed-page-constraint-boundary.integration.test.ts`, `provider-page-transaction-limit-matrix.integration.test.ts`; see `provider-page-transaction-limits.md`. |

Integration tests require an explicitly selected disposable PostgreSQL target.
They use synthetic records and do not fetch source pages or access runtime data.
The operation-count proof is not a live throughput benchmark. No source request
sizes, schema, record-order semantics or retry classifications change here.
The optional transaction-budget forwarding and first-attempt lease reserve support
the separately reviewed explicit remote execution budget; local defaults remain.
The complete handoff gate remains `npm run verify:framework`.
