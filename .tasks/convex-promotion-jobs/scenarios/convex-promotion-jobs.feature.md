# Feature: Distributed Hybrid Convex Promotion Jobs

Status: approved for implementation
Owner: `convex-promotion-jobs/001`–`009`
Companion spec: `tech-001-distributed-promotion-jobs.md`

## Scenario: A provider commit wakes only its local publication job

Given Provider A commits material canonical changes and promotion changes
When the provider transaction commits
Then Provider A's local wake generation advances atomically
And no Provider B or central manifest row is mutated

Coverage: `001`, `005`

## Scenario: Lost immediate delivery is repaired locally

Given Provider A has a committed pending wake
And its immediate adapter delivery is lost
When Provider A's next trusted one-minute schedule checks in
Then the same provider-local job reconciles the durable wake
And no operator reconstructs a delta

Coverage: `003`, `005`

## Scenario: Provider publication is independent of central availability

Given Provider A has a complete release and central is unavailable
When its exact Convex completion receipt is accepted
Then Provider A commits its completed head and completion outbox atomically
And later relay replay creates one central inbox fact and one gate generation

Coverage: distributed `014`, `003`, `005`

## Scenario: One failed provider does not block another

Given Provider A's database is unreachable
And Provider B has settled work
When provider jobs and central manifest reconciliation run
Then Provider B can complete and activate
And Provider A remains explicitly unavailable or pending

Coverage: `003`, `004`, `005`, `006`, `007`

## Scenario: A central gate changes one provider only

Given the active manifest contains Provider A and Provider B
When the central coordinator advances Provider A
Then Provider A selects its new complete release and compatible catalog version
And Provider B's entry remains byte-for-byte identical

Coverage: distributed `015`, `004`

## Scenario: Disablement does not unpublish implicitly

Given Provider A is disabled while its manifest entry is active
When lifecycle observation and manifest reconciliation run
Then the active entry remains selected
And removal requires an explicit authorized `remove` operation

Coverage: `004`, `007`, `008`

## Scenario: A stale manifest compare-and-swap preserves public state

Given another activation changed the active manifest
When a stale Provider A gate request executes
Then the current active manifest is returned and persisted as conflict evidence
And the stale request does not overwrite any provider entry

Coverage: distributed `015`, `004`, `009`

## Scenario: A newer wake survives an older invocation

Given an invocation observed wake generation N
When generation N+1 commits before N closes
Then N acknowledgement leaves N+1 pending
And the next invocation reconciles current durable truth

Coverage: `001`, `005`

## Scenario: Same-key replay remains safe after pruning

Given a terminal invocation summary was pruned before delivery-key expiry
When the original scoped key is retried
Then its tombstone returns `existing_pruned`
And no check-in, lease, publication, relay, or manifest action occurs

Coverage: `001`, `005`, `009`

## Scenario: Work continues beyond the runtime budget

Given provider or central gate work remains at the 50-second limit
When the invocation ends its bounded work
Then continuation intent is durable before `continuation_required` closes
And the next invocation resumes committed progress

Coverage: `003`, `004`, `005`

## Scenario: Exact schedule boundaries determine liveness

Given baseline 12:00 and last admitted window zero
When evaluated at 12:02:00
Then only window one is countable and health is healthy
When evaluated at 12:02:00.001
Then two windows are countable and health is overdue
When evaluated at 12:03:00.001
Then three windows are countable and one condition is established

Coverage: `006`

## Scenario: Reachability does not fabricate recovery

Given a provider has an alerting schedule condition
When its database becomes reachable but exposes no newer cron check-in
Then its last trusted schedule judgment remains alerting
And only a strictly newer trusted check-in can recover the condition

Coverage: `006`

## Scenario: The dynamic evaluator tolerates a partial outage

Given the roster contains N eligible providers
And one provider read times out
When the central evaluator completes
Then it records expected N, reachable N-1, unavailable one, plus the manifest result
And healthy provider judgments remain current

Coverage: `006`, `007`

## Scenario: Monitoring uses live and last-known evidence safely

Given Promotion Jobs previously read Provider A successfully
When a later provider-gateway read fails
Then the page retains only Provider A's matching sanitized last-known projection
And it marks that evidence stale without presenting it as healthy live state

Coverage: `007`, `008`

## Scenario: Monitoring never exposes protected authority

Given an authorized operator opens overview or invocation detail
When provider and manifest evidence is returned
Then organization, deployment, provider UUID, database topology, credentials,
key IDs, claims, request/response/receipt bodies, and raw canonical data are absent
And all identifiers used for detail are opaque and scope-bound

Coverage: `007`, `008`, `009`

## Scenario: Clean cutover prevents dual promotion authority

Given every legacy composite attempt is terminal or drained
When distributed provider schedules and the central manifest schedule activate
Then the legacy loops were already stopped
And the external detector arms only after the first complete dynamic evaluation

Coverage: `009`

## Scenario: Healthy provider activation remains under one minute

Given healthy dependencies and a settled provider change
When immediate provider publication and its central gate activation complete
Then the active entry reflects the change within the under-one-minute objective
And the evidence covers every active launch provider without a fixed roster

Coverage: `009`
