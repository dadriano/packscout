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

## Explicit second-failure review

Version 1 still accepts only the failed original continuous cycle and rejects a
failed continuation child. Version 2 is a separately reviewed admission with the
literal authorization `operator_requested_two_failure_head_continuation`. It
accepts exactly two zero-commit failed runs: the original cycle and the one child
created by a completed version 1 continuation. `previousReview` must itself be a
strict version 1 review. Nested version 2 reviews, skipped ancestors, repeated
operation/run IDs and further depth are rejected. This is an operator procedure,
not a retry policy or permission to repeat failures.

The new review preserves the original head/adoption/continuous-cycle proof and
adds five full-row audit sequence/digest pins: the prior immutable continuation
receipt, its completed queue handoff, the last audited lease claim, the guarded
Resume, and the Run-now request. It pins the completed prior Resume command too.
The previous review, both failed run digests and originating commands remain
immutable. A completed queue-handoff receipt proves only that the child was
queued; the failed child's exact terminal state is independently checked.

The shared database chain proof checks those relations during read-only review
and again inside the public Resume transaction. Both failures must have all eight
counters zero, no page rows, and matching complete requested/final cursors equal
to the runtime and original reconciled head. The child must be the deterministic
independent child of the previous operation, with the exact operator,
configuration, completed `RUN_STARTED` command and audited prior Resume. All
prior operation audits and commands are retained and hashed. Foreign sibling
continuations, unexpected subsequent runs, changed action/actor/target, missing
claims, changed generation/row version/fence, changed source authority or missing
reconciliation refuse. The prior claim fence and child's execution fence must
agree, and the previous guard digest is recomputed from the preserved review.

The prior operation must contain the exact normal queued-run startup lifecycle:
the operator's error-to-idle Resume transition and terminal command audit, then
the runner's idle-to-running transition, the operator-attributed run-start audit,
and the completed Run-now command audit. Only the runner transition has a null
operator and command. Each action binds its command/run/provider target, exact
generation or lease fence, timestamp and sequence relative to the completed queue
handoff. Missing, duplicate, unknown or misbound rows refuse admission; the null
actor is not a general exemption. Those rows are included in the immutable history
digest. The original Resume and queue utilities retain their narrower pre-execution
replay rules.

Apply uses the same atomic lease/claim, audited Resume and fenced Run-now path.
Only the newly reviewed operation can replay its receipt/Resume/queue crash gaps;
it queues at most one new independent child. Later holds, changed history or an
already-started child stop replay. The utility performs no source requests or
launches. Maintenance must first finish and verify the narrow cause-specific fix,
then separately review and start the sole queued child. It may establish a fresh
polling operation only after that child succeeds, completes reconciliation and
is promoted. Existing runtime holds for all other providers remain untouched.

## Verification

Focused tooling tests use synthetic repository fixtures and execute the real
command, lease, Run-now, queued-start and terminal repository methods. They cover preserved parent/history,
zero-commit and provenance refusals, same-transaction Resume races, claim-audit
rollback, all three crash boundaries, exact replay, later operator holds and queue
lease/deadline expiry. Shared paused-head/CLI tests protect the existing admission,
strict TLS and private-file checks. Run the unchanged `npm run verify:framework`
with no real database environment before deployment; the maintenance owner runs
that canonical gate once the complete candidate is stable.

The depth-two acceptance map is automated by
`scripts/local/provider-failed-head-chain.test.mjs`: explicit admission and history
preservation; unchanged v1 refusal; bounded depth/uniqueness; every zero counter
and full-cursor boundary; forged/missing actor/action/target/command evidence;
atomic drift and deadline refusal; claim rollback; exact public replay; and all
three crash boundaries without a second queued child. The independent
`scripts/local/provider-failed-head-chain-postgres.test.mjs` exercises normal
run and lease methods against an owned disposable PostgreSQL fixture, including
startup-audit tampering. No test connects to a provider source, deployed database,
or Convex.
