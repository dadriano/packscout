# Task: Run Parallel Platform Processors

**ID:** dataforest-source-integration/007
**Depends on:** dataforest-source-integration/004, dataforest-source-integration/006
**Blocks:** dataforest-source-integration/008
**Estimated scope:** large
**Estimated effort:** 4–5 days for one builder, including bounded concurrency, scheduling, continuation, recovery, diagnostics, and integration tests
**Status:** done

## Start Here

Run four due fixture sources with four execution slots and four independent one-request platform lanes, then prove all four source-adapter calls can overlap while each source advances only its own sequential opaque cursor and DataForrest's hard maximum of two is never approached.

## Objective

Operate Courtyard, Collector Crypt, Phygitals, and ClutchPacks as concurrent, failure-isolated platform processors inside one local supervisor process.

## Context

The current worker drains imports sequentially. First-pass ingestion instead needs a bounded pool of logical provider lanes. PostgreSQL remains authoritative for due schedules, queued runs, leases, cursors, and restart recovery; concurrency is an execution behavior, not a second queue.

Pages within one source remain sequential because page N supplies the opaque cursor for page N+1. Different sources may fetch, map, and commit at the same time. The generic supervisor owns four execution slots and task 002's request-permit-lane coordinator, then calls the source adapter pinned by each run with one fenced request lease. DataForrest allows two requests per platform, while PackScout operates each platform lane and the separate connection-test lane at one request. Exactly one local supervisor process is supported and enforced; cross-process capacity sharing and production hosting are deferred.

## Requirements

### Concurrent execution

- Run up to four bounded work items concurrently across import-page attempts, connection tests, and source tests, defaulting the generic execution pool to four while the coordinator separately enforces one request for every DataForrest platform lane and one for the provider-free connection-test lane.
- Permit at most one queued or running import and one in-flight page request per source.
- Keep source pages sequential while allowing different providers to fetch, map, commit, retry, and finish independently; therefore useful page-read concurrency is at most four, one page per provider. Each independent platform lane operates at one request beneath DataForrest's provider maximum of two.
- Isolate every source-owned rejection, timeout, mapping failure, or action-required result so it releases only that source's slot and cannot terminate sibling jobs or the supervisor loop; a shared connection episode may place only sources bound to that profile into an explicit shared wait state.
- Admit an import page or operational test only when one generic execution slot and its exact request-lane permit are both grantable, without holding either resource while waiting for the other. Treat one bounded upstream response-body capture or normalized request-failure classification as the lane-permit quantum, except that a typed connection-blocking failure must create or coalesce its episode through detecting-request-lease CAS before the permit wakes another waiter. Retain the execution slot through page commit or failed page attempt, or through a test's terminal or fenced result; assign each free resource to its oldest eligible waiter, and never let a continuation or repeated test jump older unserved work in that lane.

### Backfill and incremental scheduling

- Start or resume a source from its committed cursor when the source is active and not paused.
- Continue a run across fair one-page turns while the committed continuation is `continue` and the run remains below 1,000 committed pages and 15 minutes elapsed.
- At either run bound with `continue` remaining, finish without failed health and enqueue or schedule exactly one immediately eligible continuation from the committed cursor.
- On committed `poll_after`, mark the source at its current upstream head and set next due to the greater of that source's configured interval and the adapter's minimum delay.
- Default every provider to 60 seconds after head and preserve independent valid intervals from 60 through 86,400 seconds; the supervisor's internal database check cadence never creates an early upstream request, and freshness cannot become stale before next due plus 15 minutes.

### Manual control and recovery

- Let an authorized manual request become immediately due and return whether it created work or coalesced with that source's queued or running import.
- Stop a requested pause after the current page commit, prevent another fetch, preserve the cursor, and resume with exactly one run from that cursor.
- Retry bounded transient failures against the same cursor and place filter, source configuration, cursor, mapper, identity, or exhausted source-owned failures in source-scoped action-required state without changing sibling providers.
- Open one connection-revision action-required episode and advance its health generation for shared credential, authorization, endpoint, TLS, destination, or profile-configuration failures; cancel queued bound work, abort uncompleted request leases, and make all and only bound sources wait without moving cursors, while other profiles and the supervisor remain operable.
- Stop taking new claims during graceful shutdown, let active pages reach a safe commit boundary, and recover killed work after lease expiry from the last committed cursor.

### Diagnostic feed

- Persist source-scoped events for work due, run queued or coalesced, run claimed, adapter request started, retry, page committed, continuation, poll-after or head reached, pause, resume, lease loss or recovery, and terminal outcome.
- Apply task 002's event-kind correlation matrix so lifecycle, test, run, page, and connection events carry only their required identifiers without fabricating run, page, provider, or source values.
- Record severity, phase, safe event code, timestamps, duration, bytes, counts, normalized continuation, minimum delay only for `poll_after`, retry delay, and bounded failure evidence without arbitrary exception text.
- Record shared connection failures once as connection-scoped events that task 008 can label in each affected source feed; never copy another source's source-scoped event into the feed.
- Mirror bounded structured events to local process output, but treat the committed 30-day diagnostic feed as the admin system of record.

### Shared connection recovery

- Allow at most one pending or running recovery connection test correlated to the blocking episode, open health generation, and one nonrevoked same or candidate target revision; grant only that job a recovery request lease through the separate connection-test lane while normal connection tests, source tests, and page reads remain fenced, coalesce duplicates, and allow a later explicit attempt after a failed immutable result.
- On successful same-revision recovery, resume eligible work from committed cursors; on tested revision replacement, terminate old pinned work and create exactly one new-revision run per eligible source from its cursor.

### Uncertain transition recovery

- Write the sanitized durable request attempt before each adapter call and terminalize it with the normalized request-boundary outcome. If the pre-call insert exhausts task 002's control-plane retry policy, close the unused request lease, atomically release the paired resources, make zero upstream calls, and self-fence the whole supervisor.
- Apply task 002's exact three-attempt, 100/400 ms backoff, five-second transaction-timeout, 16-second control-plane policy to every attempt terminalization and applicable blocking-episode transition; no permit wakes and no page normalization or test-result publication starts first.
- On exhaustion, irreversibly self-fence locally, reject all new claims, calls, or persistence, and compare-and-transition the owner epoch from `active` to `fenced_draining`; after that durable transition, page/test transactions cannot commit. If the transition is temporarily unavailable, stop renewal and retry only the fence while aborting active leases; already-submitted transactions may resolve under the predecessor epoch before the durable fence, so takeover reconciles their durable state after expiry plus grace. Release a durably fenced owner only after zero active requests; leave any unterminalized attempt nonterminal.
- Before any adapter call, a replacement owner must find attempts from every safely released, superseded, or expired-through-grace predecessor epoch, atomically terminalize each as `connection_outcome_uncertain`, and create or coalesce its profile's blocking episode; it may then continue independent profiles while affected profiles await a correlated recovery test.

### Supervisor presence and tests

- Acquire one durable environment-scoped singleton supervisor lease with a fencing epoch before claiming imports, executing tests, or invoking any source adapter; a second process fails fast and makes zero upstream requests.
- Wait cancelably in the operation's exact FIFO permit lane: profile plus provider for source tests and page reads, or the provider-free connection-test lane for connection tests. After grant, atomically revalidate singleton epoch, job or run lease, pinned profile revision, revocation and connection-health generation, applicable source revision and lifecycle, and applicable requested cursor and generation, then issue one request lease bound to those pins and invoke the adapter only when every check succeeds.
- On failed post-grant validation, atomically release the paired execution slot and lane permit without a request attempt or adapter call; on later lease loss, enter `fenced_draining`, reject new claims and tests, abort active request leases, and fence later fetch, page commit, or test-result persistence under the lost epoch.
- Use the shared launch contract's 60-second lease, renewal at least every five seconds, 10-second request timeout, and takeover no earlier than 15 seconds after lease expiry so an old bounded request cannot overlap a replacement owner.
- Publish only the owning lease as heartbeat and capacity state, release it on graceful stop, execute pending tests without moving cursors or canonical data, and let one replacement resume only after safe release or expiry plus grace.

## User-Facing Behavior

An operator sees four independently progressing processors. Courtyard can retry or pause while Collector Crypt, Phygitals, and ClutchPacks continue. A manual request made while no worker is live remains visibly queued rather than claiming to run.

## Interface Contract

The supervisor exposes:

| Boundary | Required state |
|---|---|
| Capacity | Active and maximum execution slots plus exact platform and connection-test request-permit lanes |
| Source lane | Source type and revision, mapper version, lifecycle, exact `request_lane_capacity` or other wait reason, active run, lease age, progress, committed cursor fingerprint, continuation, and next due time |
| Work result | Created, coalesced, continued, reached head, paused, retrying, action required, or terminal failure |
| Presence | Fenced singleton epoch, expiring heartbeat, draining state, capacity, and safe takeover boundary |
| Diagnostics | Ordered source or connection events retained for 30 days |

Task 008 may observe and command these boundaries but cannot start or stop the operating-system worker process.

## Acceptance Criteria

### Parallel and fairness proof

- [x] With four DataForrest sources due and four execution slots, all four providers can overlap while each source and platform lane remains at exactly one possible in-flight page.
- [x] Work holds neither resource until an execution slot and its exact lane permit are both grantable; the permit releases after bounded response-body capture or normalized request-failure classification, with a blocking episode persisted first when applicable, while page or test validation continues under its execution slot. The slot releases after page commit, failed page attempt, or terminal or fenced test result, and each free resource goes to its oldest eligible waiter before a continuation or repeated test can jump older unserved work in that lane.
- [x] Waiters on one saturated platform lane consume no execution slots while waiting, so an eligible operation for another platform on the same shared profile or for the separate connection-test lane starts without waiting for that saturated lane.

### Lane isolation proof

- [x] Pages remain cursor-sequential inside one source, while different providers commit independently without shared state.
- [x] A source failure releases its slot and platform-lane permit, records only that source's outcome, and leaves sibling processors and the supervisor alive.
- [x] Simultaneous shared credential or endpoint failures advance one connection health generation and store one episode through detecting-lease CAS, coalesce sibling outcomes, reject stale detectors, cancel queued bound operations and uncompleted leases before another call, preserve cursors, grant only the single correlated recovery job a request lease with later retry, and leave independent profiles and admin operations available.

### Scheduling and recovery proof

- [x] `continue` safely continues or requeues work, `poll_after` waits for the greater of source interval and adapter minimum, and vendor poll values never reach the supervisor.
- [x] Manual requests coalesce, pause stops after a committed page, resume uses the committed cursor, and repeated commands remain idempotent.
- [x] Graceful and killed-process recovery preserve page atomicity, lease ownership, queued work, and independent schedules.
- [x] Four providers may hold different intervals, each defaults to 60 seconds, and frequent database checks produce no early source-adapter calls.
- [x] An A-to-B-to-A cursor cycle remains rejected across run rollover and supervisor restart without parsing the cursor value.

### Diagnostic proof

- [x] Every durable transition produces an ordered source-scoped or explicitly connection-scoped event with the task-002 correlation required for its lifecycle, test, run, page, or connection event kind; absent identifiers are never fabricated.
- [x] No accepted-record log explosion occurs, and seeded secrets, cursors, vendor cursors, payloads, personal identifiers, transaction identities, and stack text never appear.
- [x] A second supervisor fails before any claim, test, or upstream call; renewal loss drains and aborts the old owner, and release or expiry plus grace permits one takeover with zero old/new request overlap.
- [x] Pending connection and source tests hold exactly one generic execution slot through bounded validation and their terminal or fenced result, release their connection-test or platform-lane permit after boundary terminalization, and use one compare-and-transition result transaction that references the terminal attempt and requires an active request-time supervisor epoch plus current job lease, expected pre-test health generation, and applicable source revision; blocking request failures persist their result at the boundary and no attempt terminalizes twice.
- [x] If a queued test or page read is revoked, disabled, replaced, loses its claim, or changes cursor generation before paired grant, the post-grant guard atomically releases both resources with zero request attempts or adapter calls.

### Uncertain transition proof

- [x] Exhausted pre-call attempt insertion makes zero upstream calls and releases its paired resources; exhausted terminalization or blocking-transition persistence follows the exact shared retry policy and self-fences the owner. A successful owner-state CAS blocks later commits; an unavailable CAS stops renewal and persistence and permits only already-submitted transactions to resolve under the predecessor epoch before takeover reconciles durable state after expiry plus grace. Takeover atomically terminalizes remaining predecessor attempts as uncertain and opens or coalesces their episodes before any further call, after which admin can run the bounded recovery path.

### Adapter-neutral runtime proof

- [x] Every claimed run resolves its pinned source type and mapper version through separate registries; the supervisor contains no DataForrest endpoint, auth, filter, cursor, or poll branch.
- [x] A test-only alternate source uses the same claim, execution-slot, lane-permit grant, epoch-validation, continuation, pause, recovery, and diagnostic path with its own provider lane.
- [x] A source adapter cannot issue unmetered parallel subrequests or consume another platform or connection-test lane's permits.
- [x] The test-only alternate adapter is unavailable to production claims, tests, and admin configuration.

## Verification

- `node --import tsx --test packages/services/src/provider-source-supervisor.test.ts apps/worker/src/provider-source-supervisor-executor.test.ts apps/worker/src/provider-source-supervisor-runtime.integration.test.ts packages/database/src/provider-source-supervisor-recovery.integration.test.ts` — 46/46 passed.
- `npm run verify:framework` — passed end to end, including framework checks, Prisma validation, zero-finding standards ratchet, lint, typecheck, all workspace tests, tooling tests, volume tests, and production builds.
- `git diff --check` — passed.

## Spec Compliance

- Related specs reviewed: none; this feature has no `tech-*.md` or `ux-*.md` companion specs.
- Alignment: implemented the task contract and the related BDD scenarios through the source-neutral supervisor, durable PostgreSQL control plane, production worker composition, and test-only alternate adapter.
- Divergences: none.
- Verification: the Task 007 anchor suite and canonical framework verifier listed above both pass.
