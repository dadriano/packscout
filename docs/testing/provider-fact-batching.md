# Provider fact batching acceptance

The generic mixed-page writer groups at most 100 adjacent pulls or 100 adjacent
market events. It never crosses catalog or source-quarantine records. Reference
prefetching is bounded to 1,000 keys per table and 1,000 pull items; larger valid
input uses the existing per-record path. Existing facts are never rewritten.

The original and batched paths share candidate parsing and canonical validation.
Checks before the immutable-key lookup remain before replay; create-only checks
remain after it. Known immutable corrections produce the existing per-record quarantine evidence
without rewriting the prior fact or forcing valid neighbors onto the serial path.
Repeated keys and other known record errors roll back the chunk before
the original ordered writer runs. Unknown failures still abort the entire page.
The page checkpoint, counters, quarantines, activity outbox, facts and ordered
promotion range remain in one fenced transaction, including deferred constraints.

| Given / When / Then | Automated coverage |
| --- | --- |
| A synthetic valid page contains 1 category, 775 collectibles, 795 pulls and 268 market events (1,839 records); new and replayed facts commit; all model/raw calls stay below 250 while counters, identities and promotion order remain exact. | `packages/database/src/provider-fact-batch-latency.integration.test.ts` |
| A synthetic page matches the observed count profile: 7 categories, 17 packs, 775 collectibles, 795 pulls with 462 immutable corrections and 9 replays, 268 market events and 3 rejected catalog records (1,865 records); all 1,391 accepted / 9 duplicate / 465 quarantined outcomes, old facts and ordered promotions are exact without serial fact inserts. | `packages/database/src/provider-fact-batch-conflicts.integration.test.ts` |
| Repeated immutable keys include identical and conflicting digests; the first fact is preserved, duplicate counts stay exact, and only corrections are quarantined. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Existing facts replay with create-only invalid values; historical validation timing and no-enrichment behavior remain unchanged. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Catalog appears between fact groups or is retired; unresolved and retired-subject behavior retains original ordering. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Native foreign keys fail inside bulk inserts; chunk rollback removes all partial parents/items before per-record quarantine and later valid records commit. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Custom check errors, unknown P2010 or P2028 occur after writes; the whole page rolls back without a new retry classification. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Insert counts disagree or provider/fence pins differ; partial identities cannot escape and unauthorized pages cannot write. | `packages/database/src/provider-fact-batch.integration.test.ts` |
| Pulls have multiple ordered items or exceed the batch item limit; ordinals and promotion order remain exact without rejecting admitted input. | `packages/database/src/provider-fact-batch-boundaries.integration.test.ts` |
| Accounts and instances are active, retired, missing or bound to another collectible; original reference and foreign-key validation is retained. | `packages/database/src/provider-fact-batch-boundaries.integration.test.ts` |

The PostgreSQL tests require an explicit disposable
`PACKSCOUT_TEST_ADMIN_DATABASE_URL`; they never load a runtime `.env`.
The transport model multiplies measured awaited operations by an assumed latency;
it is not a measurement or guarantee of live page duration. No transaction budget,
lease duration, source request, schema or retry allowlist changes are included.
