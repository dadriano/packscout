# Task: Run One Provider Publication Job to Head

**ID:** convex-promotion-jobs/003
**Depends on:** convex-promotion-jobs/001, convex-promotion-jobs/002, distributed-canonical-warehouse/014
**Blocks:** convex-promotion-jobs/005
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Run one bounded, independently invokable provider-local job from its durable
promotion checkpoint to the latest settled provider head without requiring
central availability or another provider credential.

## Requirements

- Open the provider database from trusted pinned identity or the central
  locator/gateway; never from a caller-supplied provider key or route.
- Reconcile the provider-local wake and Task 014 publication state, assemble or
  reuse complete immutable releases, and publish through the current Convex
  provider-release contract.
- Persist exact request bytes before send. Resolve ambiguous/lost responses by
  authenticated signed status before resend or checkpoint movement.
- Advance completed release/checkpoint only with an exact accepted receipt.
- Commit completion/reuse plus typed completion outbox evidence atomically.
- Drain at most 50 seconds and 25 attempts. Persist continuation before closing
  `continuation_required`.
- A schedule check with no outstanding delta closes `no_change` with no Convex
  mutation. Overlap or held lease closes safely without duplicate work.
- First-read failure, cancellation, crash, lease loss, target drift, invalid
  receipt, and retry exhaustion always terminalize or leave recoverable durable
  state; deadline resources are disposed.

## Acceptance Criteria

- [x] Provider A reaches its latest settled head while Provider B is failed,
  unreachable, paused, or absent.
- [x] Duplicate/reordered trigger deliveries and process restart create no
  duplicate release or checkpoint advancement.
- [x] Exact found/not-found status recovery works across key overlap; unsigned,
  cross-provider, or mismatched proof fails closed.
- [x] A wake arriving during generation N remains pending after N completes.
- [x] Fifty-second exit creates durable continuation and resumes committed
  progress.
- [x] Completion succeeds while central is unavailable and later relay replay
  yields one central completion fact.
- [x] No provider job publishes another provider, activates a manifest, writes
  central state, or upserts canonical rows directly into Convex.

## Verification

Run distributed Task 014 focused tests, provider-local persistence tests,
one-shot worker unit/composition tests, current Convex provider-release
security/lifecycle/reconciliation tests, worker/services/database
typecheck/lint, and a two-provider outage-isolation integration test.

## Spec Compliance

The prior `platform-promotion-job` tests are behavioral port sources. Shipping
code uses provider-local clients and provider identity.

Provider one-shot, status recovery, continuation, cached-pin outage isolation,
completion relay, and provider-local persistence checks pass. Live outage and
cutover certification remain isolated in Task 009.
