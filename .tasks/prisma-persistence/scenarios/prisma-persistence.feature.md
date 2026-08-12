# Feature: Prisma Persistence Cutover

Status: approved planning contract — implementation not started
Owner: prisma-persistence

## Scenario: A clean environment is provisioned only from Prisma history

Given an empty disposable PostgreSQL 16+ database
When the checked-in Prisma migration history is applied
Then the complete PackScout persistence model is available to every supported workflow
And applying the supported deployment migration command again produces no drift or destructive change

Coverage: Automated — `packages/database/prisma/schema-parity.test.ts` applies the checked-in migration through Prisma Migrate on an empty PostgreSQL 16 database, verifies parity, and reapplies it without drift.

## Scenario: PostgreSQL preserves the complete invariant contract

Given the clean Prisma-provisioned schema
When a direct write violates a check, scoped relationship, deletion restriction, or partial active-work uniqueness rule
Then PostgreSQL rejects the write
And the invariant holds without relying only on repository validation

Coverage: Automated — `packages/database/prisma/schema-parity.test.ts` inspects the committed parity manifest and directly proves scoped relationships, state checks, partial uniqueness, defaults, cyclic scope, and deletion restrictions.

## Scenario: Persistence remains organization-isolated and protects sensitive evidence

Given two organizations with operators, providers, runs, canonical records, secrets, and protected evidence
When one organization attempts to read, reference, mutate, or claim the other organization's data
Then the operation returns its stable missing or organization-scope outcome with no cross-organization side effect
And credentials, raw actor identifiers, and protected payloads never enter canonical, operational, audit, or browser-safe results

Coverage: Partially automated — task 003 covers identity, provider controls, secrets, and protected evidence with real PostgreSQL tenant, contention, atomic-audit, and browser-safe service assertions; tasks 004–006 complete the remaining persistence domains.

## Scenario Outline: Concurrent workers claim durable work exactly once

Given eligible `<work>` is available
When two workers race to claim it
Then no more than one worker owns the same unit while its lease is valid
And another worker can recover the unit after lease expiry without duplicating completed effects

Examples:

| work |
|---|
| scheduled provider work |
| queued import work |
| estimated EV recomputation |
| quarantine retry |
| retention evidence batch |

Coverage: Partially automated — task 004 uses independent Prisma clients on real PostgreSQL for scheduled provider work, queued import work, and estimated-EV recomputation; task 006 completes quarantine-retry and retention contention.

## Scenario Outline: A provider page commit is all-or-nothing

Given an import run starts at a durable cursor and `<ownership>`
When `<commit attempt>`
Then `<persistence outcome>`
And the run counters and cursor `<checkpoint outcome>`

Examples:

| ownership | commit attempt | persistence outcome | checkpoint outcome |
|---|---|---|---|
| belongs to the caller | a valid mixed page is committed | evidence, observations, outcomes, canonical history, quarantines, relationships, and EV work become visible together | advance exactly once |
| belongs to the caller | any persistence step fails | none of the page writes remain visible | remain unchanged |
| is missing, expired, or foreign | the page is submitted | no page write becomes visible and ownership loss is reported | remain unchanged |

Coverage: Manual gap — task 005 must preserve atomic page-commit, rollback, and ownership tests in the Prisma integration harness.

## Scenario Outline: Replays preserve one truthful history

Given a source page and its next cursor are already durable
When `<later input>` is processed
Then `<history outcome>`
And recovery continues from the last committed cursor without duplicating completed effects

Examples:

| later input | history outcome |
|---|---|
| the identical page or source content | no duplicate page, source identity, or canonical revision is created |
| the same idempotency key with conflicting page content | a stable conflict is returned and stored state is unchanged |
| changed content for the same external identity | exactly one new source and canonical revision becomes current while prior history remains available |

Coverage: Manual gap — task 005 must preserve replay, revision-history, and crash-recovery integration tests.

## Scenario: Large page commits remain bounded

Given a provider page containing 550 records with accepted and quarantined outcomes
When the page is committed
Then evidence, projections, observations, outcomes, counters, and replay behavior remain correct
And the commit issues fewer than 80 database statements

Coverage: Manual gap — task 005 must retain the measured large-page statement-budget regression.

## Scenario: Quarantine, retention, and operations remain recoverable

Given imported evidence has retry, retention, health, and alert state
When workers retry invalid data, expire eligible protected payloads, and operators acknowledge or resolve alerts
Then claims, history, counters, canonical records, and operator-safe summaries remain consistent across restarts
And permanent evidence, protected payload boundaries, alert deduplication, and organization scope remain enforced

Coverage: Manual gap — task 006 must preserve quarantine, retention, alert, health, pagination, and restart integration coverage.

## Scenario: Real runtimes use the shared Prisma persistence boundary

Given a clean migrated database and valid runtime configuration
When the real admin, worker, service integration, and embedded local compositions start
Then supported workflows use the shared Prisma persistence package without changed service or HTTP behavior
And shutdown releases the Prisma database client cleanly

Coverage: Manual gap — task 007 must preserve real composition, lifecycle, boundary, and smoke coverage.

## Scenario: No executable Drizzle implementation remains

Given every PackScout runtime passes against the Prisma persistence boundary
When dependency, source, migration, build, and framework checks run
Then executable source, manifests, exports, scripts, configuration, schemas, and migration artifacts contain no Drizzle implementation
And there is no dual-read, dual-write, legacy migration, or compatibility path

Coverage: Manual gap — task 008 must add the final removal check and pass `npm run verify:framework` from a clean checkout.
