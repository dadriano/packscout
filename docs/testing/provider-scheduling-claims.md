# Provider scheduling claim acceptance map

The legacy scheduler must return at most one current claim for a due provider.
`FOR UPDATE SKIP LOCKED` locks the provider source, but its joined schedule can
come from a statement snapshot taken before another claimant committed. A fresh
schedule read under the acquired source lock must reject that stale candidate.

| Given / When / Then | Coverage |
| --- | --- |
| Given a missing, expired, or superseded schedule; when a contender takes its snapshot before the winner commits but acquires the source lock afterward; then only the winner receives a claim and its entire schedule row remains unchanged. | Automated: the three cases in `packages/database/src/provider-scheduling-claim-race.test.ts`. |
| Given an existing live claim; when another worker claims before expiry; then it receives no claim. | Automated: `database claims serialize workers, preserve cadence, and recover expired leases` in `packages/database/src/provider-scheduling-repository.test.ts`. |
| Given an expired lease or a due next interval; when a worker claims; then recovery and cadence retain their existing behavior. | Automated: the same existing scheduling test. |
| Given a stale or foreign worker; when it releases or completes another worker's claim; then it cannot change that claim or the provider cadence. | Automated: the same existing scheduling test. |

The regression uses independent real PostgreSQL clients at READ COMMITTED. A
test-only advisory barrier in the candidate query's ordering expression pauses
the contender before row locking without changing eligibility or candidate
order. The test observes the database lock wait before allowing the winner to
commit; it does not depend on sleep duration to arrange the race. The original
repository returns a second claim in all three cases.

Run the scheduling tests only with `PACKSCOUT_TEST_ADMIN_DATABASE_URL` explicitly
pointing to a disposable PostgreSQL 16 instance. The canonical handoff gate is
`npm run verify:framework`.

Separate follow-up: `completeClaim` and `releaseClaim` currently lock the schedule
before the provider source, opposite to the claim path. Concurrent expired-lease
recovery can therefore deadlock with completion/release. That pre-existing lock
order is unchanged by this fix; resolving it needs its own concurrency coverage.
