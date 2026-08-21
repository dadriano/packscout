# Feature: DataForrest Platform Source Integration

Status: planned — implementation not started
Owner: data pipeline build

## Scenario: Four platform sources share one connection without sharing processor state

Given one tested DataForrest connection profile
When Courtyard, Collector Crypt, Phygitals, and ClutchPacks sources reference it
Then the encrypted bearer credential is stored once
And every source retains its own immutable filter, opaque checkpoint, interval, runs, leases, health, and diagnostic feed

Coverage: Manual gap — implementation has not started. Automated ownership, uniqueness, tenancy, and isolation coverage is owned by task `dataforest-source-integration/002` and must replace this gap with a named test file or command before completion.

## Scenario: One provider can replace its source independently

Given Courtyard uses an active DataForrest source and the other providers use their own active DataForrest sources
When a conformance test disables Courtyard's source and activates a tested replacement source with the same normalized contract, record-ID scopes, and identity namespace
Then the replacement starts at its own null checkpoint while the old source, checkpoint, and provenance remain historical
And Courtyard retains stable canonical identity while no other provider's source, checkpoint, schedule, run, health, or diagnostic feed changes

Coverage: Manual gap — implementation has not started. Automated source replacement, checkpoint, provenance, and identity coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/004`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: An incompatible source identity cannot activate

Given a prospective Courtyard source adapter emits a different identity namespace or record-ID scope from the active Courtyard contract
When its tested replacement source requests activation
Then activation is rejected before a run, checkpoint, source observation, or canonical revision is created
And PackScout adds no ID crosswalk, checkpoint conversion, dual-source cutover, or reconciliation ledger in this feature

Coverage: Manual gap — implementation has not started. Automated identity-namespace, activation, no-write, and excluded-bridge coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/004`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: One plaintext bearer becomes one encrypted runtime credential

Given an authorized bearer is available through an ignored local secret for evidence collection
When an administrator bootstraps the shared DataForrest connection
Then PackScout stores one encrypted credential revision for the shared profile
And the plaintext bearer is absent from worker configuration, browser responses, diagnostics, audits, fixtures, and command output

Coverage: Manual gap — implementation has not started. Automated secret bootstrap, encryption, and redaction coverage is owned by tasks `dataforest-source-integration/001`, `dataforest-source-integration/004`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Source tests remain pending until the singleton supervisor executes them

Given an administrator has requested connection and source tests and no live supervisor owns the environment lease
When the administrator attempts activation
Then the tests remain pending and activation is rejected without moving a checkpoint or writing canonical data
And after the supervisor records current successful results the source may activate paused under the same lifecycle contract

Coverage: Manual gap — implementation has not started. Automated pending-test, live-execution, activation, checkpoint, and canonical-isolation coverage is owned by tasks `dataforest-source-integration/004` and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Adapter operations carry only their own correlation

Given the same connection profile is used for a connection test, source test, and page read
When the generic runtime builds the three source-adapter inputs
Then the connection test carries only connection-test correlation
And the source test carries source context plus only source-test correlation
And the page read carries source, checkpoint-generation, run, and page context with no test correlation
And no adapter input contains a mapper key, mapper descriptor, or canonical instruction

Coverage: Manual gap — implementation has not started. Compile-time and runtime discriminated-union, correlation-scope, and mapper-independence coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A source test releases request capacity before validation

Given one source test captures a bounded protected page while another source operation on the same stable profile waits for capacity
When the request boundary terminalizes the source-test attempt
Then the permit wakes the next eligible operation before source-test page validation begins
And the source test retains exactly one generic execution slot through bounded validation and its terminal or fenced result
And validation continues under the test job and later persists one immutable result by referencing the terminal attempt and current job, supervisor, health, and source pins
And a request-boundary blocking test failure instead stores terminal attempt, failed result, and episode once before wake

Coverage: Manual gap — implementation has not started. Automated source-test capture quantum, request-attempt terminalization, permit release, later result compare-and-transition, and blocking-failure single-write coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, `dataforest-source-integration/004`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: An opaque checkpoint cannot cross source boundaries

Given an opaque checkpoint returned for one Courtyard source revision and adapter contract
When a request uses it with Collector Crypt or a replacement Courtyard source, revision, or adapter
Then the request is rejected before the source adapter call
And every source checkpoint remains unchanged while only the invalid source becomes action required

Coverage: Manual gap — implementation has not started. Authenticated evidence and automated checkpoint-isolation coverage is owned by tasks `dataforest-source-integration/001`, `dataforest-source-integration/002`, `dataforest-source-integration/003`, and `dataforest-source-integration/004` and must replace this gap before completion.

## Scenario: A checkpoint cycle cannot return after restart

Given one source generation has committed checkpoint A and then checkpoint B under `continue`
When a later run or restarted supervisor receives checkpoint A again with `continue`
Then the generic precommit guard rejects the page before checkpoint, outcome, canonical, or diagnostic commit without parsing the checkpoint
And a valid `poll_after` result may still preserve checkpoint B because it does not request an immediate next page

Coverage: Manual gap — implementation has not started. Automated immediate-repeat, A-to-B-to-A, longer-cycle, run-rollover, restart, fingerprint, and poll-after preservation coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/006`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: One page carries mixed source streams

Given a valid Courtyard page contains catalog, pull, and trade records
When the DataForrest adapter normalizes and PackScout imports the page
Then every valid normalized observation passes through the separately pinned Courtyard mapper
And one atomic commit preserves source lineage, page outcomes, normalized continuation, and its single next checkpoint

Coverage: Manual gap — implementation has not started. Automated mixed-page, mapper-dispatch, and atomic-persistence coverage is owned by tasks `dataforest-source-integration/003`, `dataforest-source-integration/005`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: A test-only alternate adapter proves the source seam

Given a test-only Courtyard adapter has a different raw wrapper, checkpoint grammar, continuation signal, and connection profile from DataForrest
When it emits the same normalized record contract, record-ID scopes, and identity namespace through the generic processor
Then the unchanged Courtyard mapper, importer, scheduler, pause, resume, and diagnostic paths process it without parsing its checkpoint or branching on adapter type
And production and admin registries still expose only `dataforrest-events-v1`

Coverage: Manual gap — implementation has not started. Automated adapter conformance, checkpoint opacity, normalized continuation, unchanged mapping, generic runtime, production-registry, and admin-exclusion coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, `dataforest-source-integration/004`, `dataforest-source-integration/005`, `dataforest-source-integration/006`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Normalized continuation has one exact shape

Given adapter results include valid `continue`, valid `poll_after(60)`, `continue` with null checkpoint or a delay, and `poll_after` with missing, fractional, negative, or excessive delay
When PackScout validates them before persistence or scheduling
Then only `continue` without a delay and with a nonnull next checkpoint or `poll_after` with a required integer from 0 through 86,400 are accepted
And every invalid shape leaves the checkpoint unchanged and stops only that source with a stable contract failure

Coverage: Manual gap — implementation has not started. Automated discriminated-union, required-delay, bounds, persistence, scheduling, and source-isolation coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, `dataforest-source-integration/006`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A malformed record does not lose valid siblings

Given one valid page has valid catalog and pull records plus one malformed trade
When PackScout commits the page
Then valid records commit and the malformed trade receives one durable quarantine outcome
And the checkpoint advances only with the complete page evidence, record outcomes, and page diagnostic

Coverage: Manual gap — implementation has not started. Automated quarantine isolation and transaction coverage is owned by task `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: EV recomputation is part of the page transaction

Given one page changes approved pack or EV-input facts
When the page commits
Then exactly one deduplicated EV recomputation request commits with the canonical revision and checkpoint
And a duplicate page queues nothing while an enqueue failure rolls back the whole page

Coverage: Manual gap — implementation has not started. Automated EV-input, recomputation, deduplication, rollback, and checkpoint coverage is owned by tasks `dataforest-source-integration/005` and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Enum migration preserves existing derived meanings

Given the obsolete pipeline has catalog, pull, and sale record-kind assumptions
When the DataForrest source contract becomes active
Then catalog pack maps to pack, catalog card maps to catalog asset with card type, pull maps to pull, and trade maps to market event
And platform, EV input, and estimated EV remain derived kinds while sale remains only an event-type value

Coverage: Manual gap — implementation has not started. Automated contract, schema, migration, and registry coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/005`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Catalog is revisable and provider events are immutable

Given a provider record identity is observed more than once
When canonical catalog content changes
Then PackScout adds a catalog revision without overwriting history
But when pull or market-event content changes PackScout quarantines an immutable conflict

Coverage: Manual gap — implementation has not started. Automated identity, replay, revision, and immutable-conflict coverage is owned by tasks `dataforest-source-integration/005` and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Record-ID scopes distinguish reuse from identity conflict

Given task 001 proves that one raw provider ID may occur in two separately named record-ID scopes
When that ID is delivered in both scopes and later changes kind or pack/card discriminator inside one scope
Then the two evidenced scopes create distinct stable source records without collision
And the within-scope kind or discriminator change is quarantined as an identity conflict rather than creating another stable identity
And the two scopes map to distinct canonical kinds while a scope-qualified relationship resolves only the intended target
And a replacement adapter cannot activate unless it emits the same scope declarations and stable provider IDs

Coverage: Manual gap — implementation has not started. Automated evidence, record-ID-scope, legitimate-reuse, identity-conflict, and replacement-compatibility coverage is owned by tasks `dataforest-source-integration/001`, `dataforest-source-integration/002`, `dataforest-source-integration/004`, `dataforest-source-integration/005`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Source observation identity separates replay from correction

Given one source emits the same provider record, effective source time, and normalized content on a later page and credential revision
When that source also emits the same provider record with changed effective time or normalized content
Then each delivery has a separate page-and-record-index occurrence with complete source, adapter, connection, mapper, collection-time, protected-evidence, and disposition lineage
And the exact replay adds no semantic observation, canonical revision, or EV request
And the changed input adds one semantic observation plus occurrence
And changed catalog meaning may create one canonical revision while changed kind or pack/card discriminator inside the same frozen scope, pull content, or trade content becomes one conflict

Coverage: Manual gap — implementation has not started. Automated source-record, observation-hash, replay, catalog-revision, immutable-conflict, and provenance coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/005`, and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Event and money vocabularies retain their exact meanings

Given DataForrest supplies a normalized event type, currency ticker, nullable payment method, and nullable transaction hash
When a platform mapper creates a market event
Then the adapter-normalized event code and currency remain unchanged and payment method remains separate metadata
And provider-native wording remains protected evidence while missing money values never become zero or empty strings

Coverage: Manual gap — implementation has not started. Automated event, money, native-wording, and nullability coverage is owned by task `dataforest-source-integration/005` and must replace this gap before completion.

## Scenario: DataForrest unavailable does not mean sold out

Given pack observations have `available` values true, false, and null
When PackScout creates canonical and public pack states
Then the states are Available, Unavailable, and Availability unknown
And no DataForrest false or disappearance produces Sold out

Coverage: Manual gap — implementation has not started. Automated canonical, public-contract, and presentation coverage is owned by tasks `dataforest-source-integration/005` and `dataforest-source-integration/009` and must replace this gap before completion.

## Scenario: A disappeared pack can return

Given an available Courtyard or ClutchPacks pack later reports false
When a later catalog revision reports true again
Then PackScout preserves the availability history
And the pack leaves rankings and actions while unavailable and returns when available

Coverage: Manual gap — implementation has not started. Automated mapper, revision, public query, and presentation coverage is owned by tasks `dataforest-source-integration/005` and `dataforest-source-integration/009` and must replace this gap before completion.

## Scenario: Deferred mappers cannot become DataForrest sources

Given Beezie, GameStop, Trove, and Stadium Vault mapper code remains in the repository
When production DataForrest source registration is composed
Then only Courtyard, Collector Crypt, Phygitals, and ClutchPacks can be selected
And deferred mapper code and focused tests still compile without an activatable DataForrest configuration

Coverage: Manual gap — implementation has not started. Automated mapper-manifest and activation coverage is owned by tasks `dataforest-source-integration/005` and `dataforest-source-integration/006` and must replace this gap before completion.

## Scenario: Platform processors run concurrently while each checkpoint stays sequential

Given four due platform sources, two execution slots, and two approved DataForrest permits
When the local supervisor claims work
Then two different providers have overlapping requests
And no provider starts its next page until its prior page commits the next opaque checkpoint

Coverage: Manual gap — implementation has not started. Automated overlap, capacity, and checkpoint-sequencing coverage is owned by tasks `dataforest-source-integration/003` and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Request capacity belongs to the connection profile

Given four DataForrest sources share one profile capped at two requests and a test-only source uses another profile capped at one
When source reads and operational tests are due under both profiles
Then no more than two DataForrest operations overlap and no more than one alternate-profile operation overlaps
And credential revisions, providers, source instances, and tests cannot create a second permit pool for the same profile

Coverage: Manual gap — implementation has not started. Automated stable-profile capacity, cross-revision sharing, adapter-operation, and independent-profile coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A saturated profile cannot occupy another profile's execution capacity

Given four operations wait on a slow profile capped at one request, one operation is due on an independent profile, and two execution slots are free
When the generic runtime admits eligible work
Then one operation from each profile atomically receives one execution slot and its own profile permit
And the remaining slow-profile waiters hold neither resource while queued
And releasing either resource wakes the oldest work eligible for both without starving the independent profile

Coverage: Manual gap — implementation has not started. Automated paired-admission, saturated-profile isolation, and cross-profile fairness coverage is owned by tasks `dataforest-source-integration/002` and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Backlog fairness prevents one platform from monopolizing capacity

Given Courtyard has committed `continue` and three other sources are due
When Courtyard captures its bounded upstream response body, normalizes it, and later commits that page
Then its connection-profile permit becomes available immediately after response-body capture while its execution slot remains held through normalization and the page attempt
And after commit it yields the execution slot with a continuation from the committed checkpoint, while each released resource goes to its oldest eligible waiter before Courtyard can jump an unserved due source

Coverage: Manual gap — implementation has not started. Automated continuation, fairness, and capacity coverage is owned by task `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: One processor failure does not stop another processor

Given Courtyard encounters an action-required mapping or checkpoint failure while Collector Crypt is processing
When Courtyard stops at its last committed checkpoint
Then Collector Crypt commits and continues normally
And Courtyard releases its execution slot, holds no request permit, and leaves both resources available to other sources while the supervisor loop stays alive

Coverage: Manual gap — implementation has not started. Automated failure-isolation, resource-release, and supervisor-survival coverage is owned by task `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Shared authentication failure fences queued bound work

Given four DataForrest sources share a capacity-one connection revision, a second bound page is queued, and an alternate test source uses another profile
When the first DataForrest request returns an authentication failure
Then one connection-revision action-required episode advances its health generation and the queued page makes zero upstream calls
And the failed request does not wake the profile permit until that blocking transition is durable
And all four DataForrest lanes wait while every platform checkpoint and source-local health detail remains unchanged
And the alternate profile, supervisor, and authorized admin operations remain available
And at most one explicitly correlated recovery connection test may be pending or running without source state, receives the only request lease permitted under that open episode, and may call upstream while normal connection tests, source tests, and page reads make zero calls
And duplicate recovery requests coalesce, while a failed immutable attempt leaves the episode open for a later explicit attempt
And same-revision recovery resumes eligible work while a tested replacement revision creates new pinned runs from committed checkpoints without mutating old runs

Coverage: Manual gap — implementation has not started. Automated connection-health fencing, stored-once diagnostics, zero-call bound wait, same- and replacement-revision recovery, checkpoint preservation, independent-profile, and admin-operability coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, `dataforest-source-integration/004`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Simultaneous blocking outcomes create one connection episode

Given two capacity-two requests hold current detecting leases for the same connection revision and health generation
When both return a blocking authentication outcome
Then one request-lease-fenced compare-and-transition advances the health generation and stores one episode
And the sibling outcome coalesces without another generation advance or duplicate episode before either permit wakes bound work
And a late outcome whose supervisor epoch or job or run claim is stale cannot mutate connection health

Coverage: Manual gap — implementation has not started. Automated cap-two blocking outcomes, detecting-lease CAS, single generation, episode coalescing, stale-owner rejection, and permit-wake ordering coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Failed request terminalization becomes an honest recoverable state

Given a sanitized durable request attempt is in flight, another profile has an active request, and its terminal-outcome or blocking-episode transaction repeatedly fails
When three transaction attempts with 100 and 400 ms backoff, 750 ms attempt timeouts, and a three-second hard limit are exhausted
Then the supervisor self-fences locally, stops every claim, new call, and new persistence transaction, and attempts to move its durable epoch from active to fenced-draining while aborting request leases across all profiles
And a successful durable fence orders every page or test transaction before it or rejects it after it
And if the durable fence is temporarily unavailable, only a transaction already submitted under the predecessor epoch may resolve before expiry, and takeover reconciles that durable outcome instead of assuming zero results
And it releases ownership only at zero active requests or otherwise expires through the normal takeover grace while the request attempt remains nonterminal
And whether the predecessor safely releases or expires, the replacement owner atomically terminalizes that attempt as connection-outcome-uncertain and opens or coalesces one blocking episode before any adapter call
And independent profiles continue while admin shows the uncertain wait reason and permits a correlated recovery test for the affected profile

Coverage: Manual gap — implementation has not started. Automated durable request-attempt, bounded transition retry, owner stop, takeover reconciliation, uncertain admin state, independent-profile, and recovery-test coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: A pre-call request-attempt insert fails closed

Given paired execution and profile capacity was granted and the post-grant guard is current
When the durable in-flight request-attempt insert exhausts the shared control-plane retry policy
Then the unused request lease closes, both reserved resources release, and the source adapter receives zero calls
And the supervisor enters the same whole-owner self-fencing path without inventing a request-attempt row or success diagnostic

Coverage: Manual gap — implementation has not started. Automated pre-call attempt insertion, paired-resource release, zero-call, and self-fencing coverage is owned by tasks `dataforest-source-integration/002` and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A shared connection episode fences a captured page commit

Given one bound page has captured a successful response under connection health generation seven and is still mapping
When a sibling request opens a blocking connection episode and advances the revision to generation eight
Then the captured page fails its atomic precommit guard as stale
And it writes no page, occurrence, canonical, EV, diagnostic-success, or checkpoint state
And recovery later resumes that source from its last committed checkpoint

Coverage: Manual gap — implementation has not started. Automated request-time health-generation lineage, post-capture episode, atomic rollback, and checkpoint-resume coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/006`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A singleton lease prevents two local supervisors

Given one local supervisor owns the current environment lease
When a second supervisor process starts
Then it fails before claiming a run, executing a source test, or invoking any source adapter
And after the owner stops or its lease expires exactly one replacement can take over durable work from committed checkpoints

Coverage: Manual gap — implementation has not started. Automated singleton ownership, zero-call rejection, lease expiry, graceful release, and takeover coverage is owned by task `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A stale permit grant cannot invoke a source adapter

Given a supervisor is waiting cancelably for a connection-profile permit under its current singleton epoch
When the permit is granted after that epoch can no longer be renewed or validated
Then the reserved execution slot and profile permit are atomically released without a source-adapter call, request attempt, request lease, checkpoint change, or false provider failure
And only a current owner may receive a fenced request lease and make one bounded upstream request

Coverage: Manual gap — implementation has not started. Automated cancelable-wait, FIFO-grant, post-grant epoch validation, zero-call release, request-lease fencing, and single-request coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Revoked or stale work cannot call upstream after waiting

Given a page read or operational test is waiting for its connection-profile permit
When its run or job lease expires, profile revision is revoked, source is disabled or replaced, or checkpoint generation changes before the permit is granted
Then the post-grant guard rejects the stale operation and atomically releases its reserved execution slot and profile permit
And the source adapter receives zero calls and no checkpoint, page, test result, or diagnostic success is committed

Coverage: Manual gap — implementation has not started. Automated post-wait run/job, profile-revocation, source-lifecycle, checkpoint-generation, zero-call, and permit-release coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/003`, `dataforest-source-integration/004`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A partitioned old supervisor cannot overlap its replacement

Given a live supervisor owns the environment lease and has one bounded source-adapter request in flight or a captured response still mapping
When it loses lease renewal while a replacement waits for ownership
Then the old supervisor enters fenced-draining, aborts any open request, and cannot claim, test, fetch, persist a test result, or commit a captured page because those transactions require an active epoch
And the replacement waits through expiry plus the takeover grace, publishes the only current heartbeat, and starts with zero old-owner adapter requests still in flight

Coverage: Manual gap — implementation has not started. Automated renewal-loss, request-abort, commit-fencing, takeover-grace, zero-overlap, and heartbeat-ownership coverage is owned by task `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A fenced supervisor cannot persist a captured test result

Given a connection or source test captured a successful response under one supervisor epoch
When that supervisor loses ownership before the test result transaction
Then the atomic job, active-epoch, connection-health, and applicable source-revision guard rejects the result
And no profile or source becomes tested, activatable, or recovered from the stale evidence

Coverage: Manual gap — implementation has not started. Automated captured-test-response, job-lease, supervisor-epoch, connection-health, source-revision, and activation-evidence fencing coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/004`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: A test result owns its connection-health transition

Given a recovery connection test starts with the current blocking episode and expected health generation seven
When one attempt returns a blocking failure and a later attempt succeeds
Then each compare-and-transition transaction validates its expected pre-generation and stores the immutable result with its pre-test and resulting generations
And the failed attempt retains the episode without fencing itself while the successful attempt closes it and advances the generation
But an unrelated concurrent generation change fences the affected result before it becomes activation or recovery evidence

Coverage: Manual gap — implementation has not started. Automated test-result compare-and-transition, pre/resulting generations, failure retention, successful close, and unrelated-race fencing coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/004`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Provider intervals are independent of the supervisor check loop

Given the DataForrest adapter has committed `poll_after(60)` for reached-head Courtyard and Collector Crypt sources
And an administrator revises only Collector Crypt to 180 seconds
When the supervisor checks durable work frequently
Then Courtyard becomes due after 60 seconds and Collector Crypt after 180 seconds
And no earlier check invokes DataForrest or changes either source's checkpoint
And neither source becomes stale before its own next due time plus the fixed 15-minute grace
And no generic scheduler state contains `poll_after_seconds`

Coverage: Manual gap — implementation has not started. Automated schedule, timing-revision, and no-early-request coverage is owned by tasks `dataforest-source-integration/004`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Backfill resumes after supervisor loss

Given several platform processors have committed pages with `continue` remaining
When the supervisor stops and restarts after lease recovery
Then every source resumes from its own last committed checkpoint without applying a page twice
And no intentional continuation or restart is reported as a provider failure

Coverage: Manual gap — implementation has not started. Automated page-boundary, lease, restart, and health coverage is owned by tasks `dataforest-source-integration/006` and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Manual import and pause remain provider scoped

Given one provider has future scheduled or currently running work
When an authorized operator selects Run now, Pause, and later Resume
Then manual work creates once or coalesces, pause stops after the current page, and resume uses the committed checkpoint
And no other provider's schedule, run, checkpoint, or processor state changes

Coverage: Manual gap — implementation has not started. Automated manual, coalescing, pause, resume, audit, and isolation coverage is owned by tasks `dataforest-source-integration/007` and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Every processor has an isolated diagnostic feed

Given Courtyard and Phygitals commit pages concurrently and their shared connection records one bounded event
When an operator views the Courtyard diagnostic feed
Then the feed shows ordered Courtyard events plus the one stored, explicitly labeled connection event because Courtyard was bound to that profile at the event time
And pagination never duplicates the shared event or exposes a Phygitals source event, another profile or tenant, credential, full checkpoint or vendor cursor, payload, personal identifier, transaction identity, or stack trace

Coverage: Manual gap — implementation has not started. Automated diagnostic scope, ordering, composition, and redaction coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Diagnostic correlation remains truthful under a run filter

Given Courtyard has an idle-pause lifecycle event, a source-test event, a run event, a page event, and one shared connection event
When an operator filters the Courtyard diagnostic feed by that run
Then only the matching run and page events are returned and the feed reports that lifecycle, test, and connection events are hidden without fabricating run or page identifiers
And clearing the filter restores every scope-valid event in deterministic order with its safe command, test, run, or connection reference

Coverage: Manual gap — implementation has not started. Automated event-kind correlation, run-filter, hidden-event notice, ordering, and safe-link coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/007`, and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Diagnostic retention does not erase durable progress

Given a source has page-level processor events, terminal and nonterminal request attempts, and quarantined record evidence
When processor events and terminal attempts reach 30 days, raw pages reach seven days, and quarantine evidence reaches 30 days
Then eligible protected diagnostics and payloads expire and terminal attempts compact in bounded tenant-scoped batches
And immutable attempt identity, outcome hash, fence lineage, checkpoints, run and page summaries, dispositions, canonical history, health, and operator audits remain
And a nonterminal attempt cannot expire, while a reconciled terminal uncertain attempt keeps its episode link for 30 days before compaction

Coverage: Manual gap — implementation has not started. Automated retention, cleanup, and durable-state coverage is owned by tasks `dataforest-source-integration/002`, `dataforest-source-integration/006`, and `dataforest-source-integration/007` and must replace this gap before completion.

## Scenario: Admin reports honest progress and no-worker state

Given a manual import is queued while no current supervisor heartbeat exists
When an operator opens the processor overview
Then the selected provider says queued with a no-live-worker wait reason rather than running
And after a supervisor claims it the row and provider feed move to running with committed progress

Coverage: Manual gap — implementation has not started. Automated presence, progress, wait-reason, admin-route, and component coverage is owned by tasks `dataforest-source-integration/007` and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Admin roles preserve source safety

Given an administrator and data operator belong to the same organization
When they operate provider sources
Then both can view progress and diagnostics and use authorized Run now, Pause, Resume, and quarantine Retry actions
But only the administrator can change credentials, source bindings, intervals, activation, disable state, replacement, or checkpoints

Coverage: Manual gap — implementation has not started. Direct route, tenant, component, and browser coverage is owned by tasks `dataforest-source-integration/004` and `dataforest-source-integration/008` and must replace this gap before completion.

## Scenario: Storage capacity is proved before the real backfill

Given a representative mixed-page import has measured normalized rows, indexes, raw evidence, quarantine, and diagnostic storage
When PackScout extrapolates the dated full-history baseline and fixed retention windows
Then the real backfill cannot start without approved local database capacity and headroom
And measured growth during the real backfill stops safely before capacity exhaustion if the forecast is wrong

Coverage: Manual gap — implementation has not started. Automated sample measurement plus local operational evidence is owned by tasks `dataforest-source-integration/001`, `dataforest-source-integration/006`, and `dataforest-source-integration/010` and must replace this gap before completion.

## Scenario: Local bootstrap targets the real backfill database

Given an exact empty local database and ignored organization, administrator, session, encryption, and actor-key inputs
When the target-scoped bootstrap and documented runbook commands execute
Then the organization and first administrator exist in that same migrated database and admin and worker use the same approved credential-key revision
And no disposable database is substituted and no database URL, password, bearer, or key bytes appear in command arguments or output

Coverage: Manual gap — implementation has not started. Automated target validation and bootstrap coverage plus a manual runbook smoke are owned by task `dataforest-source-integration/010` and must replace this gap before completion.

## Scenario: Four real backfills reconcile before completion

Given an empty local database has one shared profile and four tested paused sources
When all four processors run the real DataForrest history to head
Then every delivered record reconciles to exactly one disposition plus canonical relationship and EV outcomes
And the feature remains incomplete until all four providers reach head with zero unresolved mapping, identity, immutable-conflict, or relationship failures

Coverage: Manual gap — implementation has not started. Real local backfill, reconciliation, and scorecard evidence is owned by task `dataforest-source-integration/010` and must replace this gap before completion.

## Scenario: Public data exposes availability without ingestion internals

Given public pack projections include available, unavailable, unknown, and explicitly sold-out states
When a buyer views the complete catalog
Then every pack has the accurate label and only available packs have current ranking or purchase eligibility
And no connection, source, checkpoint, vendor cursor, processor diagnostic, quarantine, credential, payment method, or protected provider value reaches the browser

Coverage: Manual gap — implementation has not started. Automated public contract, query, component, accessibility, and browser coverage is owned by tasks `dataforest-source-integration/009` and `dataforest-source-integration/010` and must replace this gap before completion.
