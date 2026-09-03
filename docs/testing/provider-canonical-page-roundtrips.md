# Canonical page roundtrip regression

The first two Neon Clutch attempts rolled back before committing a source page.
Their source fetches succeeded, but the second page transaction exhausted its
480-second bound while issuing recent inserts and waiting for client input.
The retained historical audit did not record per-kind translation counts; the
test below does not claim to reconstruct that private page.

`provider-collectible-batch-latency.integration.test.ts` commits a synthetic
1,519-collectible page plus its preceding category into disposable PostgreSQL.
It instruments both Prisma model operations and raw locks/savepoints, adding
one millisecond per awaited operation. New, changed and unchanged pages must
each use at most 250 database operations. At a modeled 100ms transport cost,
that reserves at most 25 seconds for roundtrips, not an import ETA or a claim
about database execution time. Production timeouts are unchanged by this test.

The exact 01108b7 baseline required 10,649 operations for the first page and
failed this ceiling. The batched implementation used 128 for new collectibles,
125 for changed rows and 77 for unchanged rows. The test also checks atomic
page receipts, saved cursor, counters, replay, identity/version retention and
ordered contiguous promotion history. It requires an explicit disposable
`PACKSCOUT_TEST_ADMIN_DATABASE_URL`; it never queries an upstream source.

New source translation audits retain only six validated numeric record counts
before page persistence. Their sum must equal the normalized record total;
collectible and membership counts must be valid catalog subsets. They contain
no bodies, source keys, cursors or credentials, and do not alter source reads.

| Behavior | Automated coverage |
| --- | --- |
| Full-page roundtrip ceiling, commit and replay invariants | `provider-collectible-batch-latency.integration.test.ts` |
| Kind partitioning without inspecting bodies; malformed measurements rejected | `provider-page-record-counts.test.ts` |
| Worker records interpreted page kinds | `provider-dataforrest-mixed-page-source.test.ts` |
| Lease-fenced translation audit and invalid-count refusal | `provider-source-request-audit-repository.integration.test.ts` |

Live acceptance still requires a new successful import, completed head
reconciliation and normal Convex promotion readback. Tests alone do not prove
those operational outcomes.
