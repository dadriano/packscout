# Collectible page batching acceptance map

The fenced mixed-page transaction groups only contiguous collectible upserts,
at most 100 records per chunk. Other record kinds, retirements, pack economics
and membership snapshots retain their boundaries. Shared normalization and
source-clock/version decisions serve both the existing canonical API and the
chunk writer; provider names do not affect the path.

Each chunk prefetches bounded category and collectible keys, keeps input
promotion order, inserts new rows without ignoring conflicts, and updates
existing rows with native PostgreSQL column types and exact active-version CAS.
Every returned ID is checked. The same row-version/lifecycle/promotion triggers
and final deferred-constraint check remain active. No transaction budget,
request size, schema, source cursor or runtime retry classification changes.

| Given / When / Then | Coverage |
| --- | --- |
| Given 1,519 realistic synthetic collectibles plus their category; when new, newer or unchanged pages commit; then complete page counters, checkpoints, IDs, versions, valuation evidence and ordered promotion entries remain correct within a bounded database-operation budget. | `provider-collectible-batch-latency.integration.test.ts`; injected latency and operation counts include raw savepoints and page fencing. |
| Given creates interleaved with updates, same data and older source values; when one chunk commits; then exact fields/defaults/timestamps and promotion order match canonical decisions; identical replay changes nothing. | `provider-collectible-batch.integration.test.ts`. |
| Given duplicate keys, retired rows, same-time conflicts, wrong versions or unresolved categories; when the chunk cannot apply; then the original record order, quarantines, candidate evidence and outbox linkage are retained. | The same integration test. |
| Given a native foreign-key failure during bulk CAS; when the chunk is rolled back; then existing per-record handling quarantines the offending record while valid records commit once. | The same integration test uses an actual PostgreSQL foreign key. |
| Given only some rows match their expected version; when SQL returns the partial ID set; then the chunk is rolled back before fallback, with no leaked version or promotion. | The same integration test forces an intervening version within the disposable transaction. |
| Given an unknown ordinary-Prisma error, unknown raw SQLSTATE or P2028 after writes; when processing fails; then the entire page rolls back without transaction retry or changed error classification. | The same integration test. |
| Given a foreign provider page; when commit is attempted; then no canonical effects occur. | The same integration test. |
| Given arbitrary or accessor-backed error metadata; when fallback is considered; then only trusted Prisma P2010 with an explicitly reviewed SQLSTATE is eligible. | `provider-canonical-batch-constraint.test.ts`. |

Fallback always restores the chunk savepoint before running the original
per-record path. A repeated key never uses a speculative cached row. A known
SQLSTATE permits this local isolation step, not an automatic transaction or run
retry; an unknown error from the original path remains a whole-page failure.
Only disposable PostgreSQL fixtures and synthetic records are used. Artificial
latency results are regression evidence, not a prediction of live throughput.
The canonical full gate remains `npm run verify:framework`.
