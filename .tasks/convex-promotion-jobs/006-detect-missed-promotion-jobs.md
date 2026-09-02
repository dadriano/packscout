# Task: Detect Missed Distributed Promotion Jobs

**ID:** convex-promotion-jobs/006
**Depends on:** convex-promotion-jobs/001, convex-promotion-jobs/005
**Blocks:** convex-promotion-jobs/007, convex-promotion-jobs/008, convex-promotion-jobs/009
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Evaluate the dynamic provider roster plus the central manifest schedule,
preserve partial-outage evidence, and raise/recover one deduplicated liveness
condition without confusing scheduler health with publication health.

## Requirements

### Exact window judgment

- Provider schedule truth remains provider-local; central manifest schedule truth
  remains central. Central observations never become admission authority.
- Window N begins at 1 and is countable only when
  `dueAt(N) < evaluatedAt`.
- `missed = max(0, latestCountable - lastAdmitted)`: 0–1 healthy, 2
  overdue, 3+ alerting.
- Pending and paused schedules accrue no misses. Resume creates a new epoch.
- Wake/manual/continuation work never resets cron liveness.

### Dynamic evaluator

- Each minute, capture the eligible central roster and its version/digest, then
  read provider schedules with bounded pagination and gateway concurrency.
- Evaluate each reachable provider independently and the central manifest row.
  Expected count is eligible provider count plus one, never a fixed nine.
- One provider timeout records `unavailable`, preserves last trusted evidence,
  and does not fail healthy provider or central judgments.
- Registry enumeration/capacity/persistence failure makes the cycle unsuccessful
  and prior judgments stale. It cannot report zero-provider success.
- Success records expected/reachable/unavailable counts, manifest result,
  roster digest/high-water, and evaluated-through time.

### Conditions and alerts

- Three missed provider windows establish one tenant-scoped durable central
  condition before alert publication. Alert delivery retry never changes the
  liveness judgment.
- Recovery requires observing a strictly newer valid local cron check-in.
  Reachability, stale replay, immediate wake, manual run, or continuation cannot
  recover it.
- A trusted pause cancels a pending open or resolves its published condition;
  resume uses a new episode identity.
- Provider conditions cannot cross organizations/providers/epochs.
- Central manifest and evaluator silence use a separate least-privilege
  system/external condition sink, not an arbitrary tenant's `admin_alerts`.
- An external detector reads only evaluator lifecycle/timing/count/digest and
  opens after three missed evaluator windows; it has no job detail or mutation.

## Acceptance Criteria

- [x] With baseline 12:00 and last window 0, 12:02:00 counts only window 1,
  12:02:00.001 counts two, and 12:03:00.001 counts three.
- [x] Exact-due check-in is on time and cannot race evaluation into a miss.
- [x] Dynamic 0/1/N provider rosters, add/disable/archive, and pagination are
  evaluated without silent omission.
- [x] One provider outage preserves its last trusted evidence and does not block
  healthy rows, provider alerts, or the central manifest judgment.
- [x] Reconnection alone does not recover; a strictly newer cron check-in does.
- [x] Concurrent evaluators and failed open/recover publication produce at most
  one condition/alert episode with retryable delivery state.
- [x] Pause and resume are non-alerting and preserve pending publication work.
- [x] Publication/settlement/activation failures remain distinct and are never
  resolved by schedule recovery.
- [x] Evaluator failure marks retained judgments stale; successful partial
  provider observation reports exact unavailable count.
- [x] The watchdog credential and response expose no provider identity, tenant,
  route, invocation, alert detail, payload, receipt, or mutation.
- [x] Safe responses omit database targets, credentials, claims, raw scopes,
  publication bodies, and protected evidence.

## Verification

Run exact-boundary unit tests, provider schedule snapshot tests, central
observation/condition transaction tests, dynamic roster pagination/capacity
tests, one-provider timeout integration, alert open/recover/pause retry tests,
watchdog auth/lifecycle tests, service/worker/database typecheck/lint, and
`npm run verify:framework` at the final group gate.

## Spec Compliance

The liveness evaluator observes split authorities; it never becomes a central
command queue or provider schedule owner.

## Completion

The evaluator, watchdog, durable conditions, exact-window policy, dynamic
roster, partial-outage, pause/resume, and redaction paths are implemented and
covered by focused checks. Live rollout evidence remains Task 009 work.
