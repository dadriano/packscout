# Reviewed continuation of a zero-commit failed head poll

This local operator utility handles one explicit recovery boundary: a failed manual
poll that committed no pages or record operations, started from an earlier fully
reconciled source head, and left the complete checkpoint unchanged. It does not
request source data, start a worker, promote to Convex, or change retry policy.
Other providers' operator holds remain in force. A failure code alone is never
permission to retry.

## Admission and preserved evidence

`scripts/local/provider-failed-head-resume.mts` requires a private, owner-only,
non-symlink review file. Its strict schema binds the clean source commit,
independent operation ID, provider/organization/operator/configuration, explicit
remote central and provider destinations with verified TLS, current authority,
migration proof file SHA256, runtime generation/row version, released import
fence, failed run and its originating command digests, exact failure time/code,
checkpoint hash, and prior successful head run and reconciliation proof digests.

Four immutable audit rows are pinned by their actual PostgreSQL sequence and full
row digest: the earlier paused-head adoption, adoption completion, continuous
operation and deterministic continuous cycle. The original adoption Resume
command is separately pinned by ID and digest. Their provider, actor, operation,
configuration, cursor and parent-child relationships must agree. The failed run's
original Run-now command must have completed `RUN_STARTED`; a later run failure
does not rewrite that command. Existing positive-page operator continuation and
its local-only admission remain unchanged.

The latest failed parent must have all eight aggregate counters at zero and no
persisted page rows. Its requested and final full cursor envelopes must match the
runtime and earlier successful head. Any changed cursor, positive count, missing
reconciliation, foreign/newer run or command, owned lease, provider/configuration
drift, or reused operation refuses admission. The snapshot also preserves all old
runs/pages, prior operation audit history, promotion ledger and quarantine count.
No cursor, parent, original receipt or configuration is cleared or rewritten.

## Review and apply

Use the clean, reviewed recovery checkout and the separately authorized remote
environment. No environment belongs in test execution. Root maintenance owns the
process inventory, pause policy, review preparation and any later worker start.

```sh
node --import tsx scripts/local/provider-failed-head-resume.mts \
  --review-file /absolute/private/review.json --check-only
node --import tsx scripts/local/provider-failed-head-resume.mts \
  --review-file /absolute/private/review.json --apply --review-digest REVIEW_DIGEST
```

Check-only performs bounded read-only database transactions and outputs a receipt
digest without raw cursors. Apply repeats file, route, membership, configuration,
process and database checks. It records an immutable continuation receipt, then
atomically acquires the normal fenced import lease with its claim audit. A
caller-requested public Resume guard validates the failed entry, provenance,
lease, runtime and full checkpoint inside the same Serializable transaction as
Resume. The successful transition is exactly error → idle, generation and runtime
row version each incremented once. The existing paused entry uses an explicit
`entry: "paused"` guard with its original checks.

Normal audited Run-now then queues one deterministic independent manual child,
under the held import lease, expected configuration/generation/checkpoint and
no-active-run guard. The child does not replace the failed parent and has no
automatic recovery parent. Its immutable continuation receipt is the provenance
link. Queue admission re-reads the database clock immediately before writes and
requires at least a complete 15-second transaction budget on both the caller's
absolute deadline and the held lease. A short or expired budget refuses writes.
Ordinary Run-now callers that omit this optional deadline retain their existing
behavior.

Receipt-before-Resume, Resume-before-queue and queue-before-completion crashes can
replay the same reviewed operation. Lease acquisition and its audit roll back
together; expired own claims can only be reacquired with their exact audited
fence. Replay creates no second Resume or child. Once the child starts or another
operator changes state, this utility refuses rather than adopting newer work.
All owned transaction callbacks drain before resources close on timeout.

The result returns the child run ID and preserved parent ID separately, not the
failed-parent pins as launch instructions. The child is **queued, not running or
caught up**. Root must separately validate the deployment, authority, sole accepted
command, full checkpoint and exclusive worker admission. The intended next step is
the normal provider manual worker once. After that child succeeds, completes its
own head reconciliation and is promoted, a new continuous head-only operation may
be anchored at the child with a fresh operation ID. Never restart the old failed
parent's resident.

The existing backfill supervisor can alternatively bootstrap a queued initial run
with new pins anchored at the child and a fresh operation ID; it records its normal
operation, execution-claim and launch receipts. That supervisor also retains its
existing bounded transient recovery policy, so it is broader than one manual
worker invocation. This utility does not select or launch either strategy. Once
execution/bootstrap starts, recovery receipt replay is no longer an admission
path. Existing historical operation receipts remain historical.

## Verification

Focused tooling tests use synthetic repository fixtures and execute the real
command, lease and Run-now repository methods. They cover preserved parent/history,
zero-commit and provenance refusals, same-transaction Resume races, claim-audit
rollback, all three crash boundaries, exact replay, later operator holds and queue
lease/deadline expiry. Shared paused-head/CLI tests protect the existing admission,
strict TLS and private-file checks. Run the unchanged `npm run verify:framework`
with no real database environment before deployment; the maintenance owner runs
that canonical gate once the complete candidate is stable.
