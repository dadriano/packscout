# Snapshot membership batching acceptance map

The existing provider snapshot contract, source ordering, pack lock, record
savepoint and page transaction remain authoritative. Batches reduce database
roundtrips; they do not raise source, transaction or lease limits.

| Given / When / Then | Automated coverage |
| --- | --- |
| Given valid partial snapshots, when 500 members are inserted or refreshed, then each full snapshot uses at most 20 database operations, including promotion allocation. | `provider-pack-content-snapshot-batch.integration.test.ts` |
| Given 1,000 active members, when a complete empty snapshot arrives, then all members retire atomically within 25 operations, in the previous promotion order and with source-effective retirement times. | Same batch integration test |
| Given nullable quantities, precise decimal values and chase evidence, when existing members update in bulk, then those values and unrelated pack economics remain unchanged in meaning. | Same batch integration test |
| Given a concurrent row-version change, when the snapshot's CAS update misses, then its receipt, earlier retirements and inserts roll back while the other committed writer remains intact. | Same batch integration test |
| Given a constraint failure in a later insert chunk, when the transaction rejects, then earlier chunks, receipts and promotions roll back together. | Same batch integration test |
| Given a trusted raw batch constraint, when its inner savepoint rolls back and the original canonical methods run, then native FK errors quarantine exactly that record while later valid records commit; a custom check error retains its prior unknown-error behavior and aborts the page. | Same batch integration test |
| Given unknown SQL or P2028 after member writes, then the whole page rolls back without broadening the retry policy; P2028 cannot enter canonical fallback. | Same batch integration test |
| Given replay, older source evidence, partial omissions, explicit removals, empty snapshots or reintroduced members, then prior snapshot behavior and immutable receipt proofs remain enforced. | `provider-pack-content-snapshot.integration.test.ts` and batch integration test |

Two valid partial snapshots establish the 1,000-member fixture. A single JSON
snapshot with 1,000 fully named items exceeds the existing 200 KiB byte bound;
tests preserve that boundary instead of enlarging it for a capacity fixture.

Production timing is not established by local PostgreSQL tests. The query-count
ceiling proves reduced roundtrips independently of local network latency.
