# Task: Surface Background Queues and Maintenance Runs

**ID:** admin-tools/008
**Depends on:** none
**Blocks:** admin-tools/009
**Estimated scope:** medium
**Status:** done

## Objective

Operators can see the pipeline's background work that isn't an import run — the estimated-EV recomputation queue and retention executions — and recover stuck queue entries, so backlog and maintenance failures stop being invisible.

## Context

Beyond provider imports, the worker performs two kinds of background work with no admin visibility today. First, estimated-EV recomputation: a durable request queue that workers claim and process; entries can back up, fail repeatedly, or sit claimed by a worker that died, and any of those silently degrades the freshness of the product's EV numbers. Second, retention enforcement: scheduled executions that expire protected raw payloads (import pages, source records, quarantine payloads — operational history is not pruned). Retention failures already raise alerts through the existing alert system, but a retention job that silently stops running is invisible today, and no surface shows what retention executions have actually done.

Both are already durable records the admin server can read. This task follows the same operational conventions as the existing runs and quarantine surfaces: bounded reads, sanitized evidence, view access for both roles, and recovery actions under the existing operational-action permissions with confirmation and audit.

## Requirements

- Recomputation queue visibility: current depth, oldest-pending age, in-flight (claimed) entries with claim age and claiming owner identity, and recently failed entries with bounded, sanitized failure reasons and attempt counts — paginated, filterable by state.
- Stuck-claim recovery: an operator holding the existing retry-oriented operational permission (the same permission that gates quarantine retry) can release a stuck claim (one whose claim age exceeds its expiry) or re-queue a failed entry, with confirmation, per-entry outcome feedback, and an audit record; recovery never loses the request or double-processes it into an inconsistent state — a concurrently completing worker wins cleanly.
- Recovery actions are bounded (single entry or a bounded selected set), mirroring the quarantine-retry interaction pattern.
- Retention-execution visibility: recent executions with start/finish times, outcome, what was pruned in counts, and bounded failure reasons for failed ones; the view makes it evident when retention has not run within its expected interval.
- No raw payloads, provider secrets, or unbounded error bodies reach the browser; evidence follows the same sanitization rules as run and quarantine diagnostics.
- View access for both operator roles under the existing view-oriented pipeline permission; mutation access requires that same retry-oriented operational permission named above; anonymous and unauthorized requests receive the standard error outcomes.
- Loading, empty, error, forbidden, conflict (entry no longer in the acted-on state), and success states covered accessibly, reusing existing admin patterns; placement fits the existing pipeline navigation without forking the shell.

## User-Facing Behavior

An operator opens the background-work view and sees the recomputation queue's health at a glance — how deep, how old, what's in flight, what's failing — and a ledger of recent retention executions. A stuck entry (claimed long past expiry by a dead worker) shows a release action; a failed entry shows a re-queue action; both confirm before acting and report the per-entry outcome. If a selected entry was meanwhile completed by a worker, the operator sees a clear already-resolved outcome, not an error.

## Interface Contract

- The admin exposes protected, paginated reads for queue entries (by state: pending, claimed, failed) with depth/age aggregates, and for retention executions with outcomes and counts.
- It exposes protected mutations to release a stuck claim and re-queue a failed entry, accepting entry identities, returning per-entry outcomes (released, re-queued, already-resolved conflict), audited like other operational mutations.
- admin-tools/009 consumes the same server-side backlog measures (queue depth, oldest-pending age, retention-overdue) as alert inputs, so those derivations live server-side and are shared, not duplicated in the browser.

## Acceptance Criteria

- [x] Queue depth, oldest-pending age, in-flight claims, and failed entries are visible with accurate, bounded, sanitized detail.
- [x] Releasing a stuck claim and re-queuing a failed entry work with confirmation, audit, and per-entry outcomes, and a concurrent worker completion resolves as a clean conflict outcome rather than corruption or double-processing.
- [x] Retention executions are listed with outcomes and pruned counts, and an overdue retention interval is visibly flagged.
- [x] Role and permission boundaries hold: both roles view, operational-action permission mutates, anonymous/unauthorized get standard errors.
- [x] No raw payloads or secrets appear in responses, rendered state, or logs.

## Verification

Admin route behavior tests prove the read shapes and aggregates, the permission matrix for reads and mutations, and the release/re-queue actions including the concurrent-completion conflict path; an integration test proves a released entry is re-claimable by a worker exactly once. The admin and affected package test suites and typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Follows the existing operations conventions exactly — `providers:view` reads and `imports:retry` mutations behind the same session/CSRF/same-origin guards as quarantine retry, keyset-paginated sanitized DTOs, bounded selections with per-entry outcomes, and the shared admin template classes and tokens from task 016.
- Divergences: The durable `completed`-state conflict is proven at the route level rather than in the database integration test, because a `completed` recomputation row requires a `calculation_revision_id` FK into `canonical_revisions` (and therefore a full source-record/entity chain); the database test proves the same race through the worker's other terminal transition (`recordFailure` on a matching claim token) plus the reverse direction — after a release the stale worker's `complete()` and `recordFailure()` both return no-op. Retention "expected interval" is derived from the published `presenceStaleAfterMs` of live worker instances rather than a new hard-coded cadence, and yields an explicit `unknown` state when no worker has published settings. A live browser smoke pass was not run: the worktree has no `.env`, so the admin server cannot boot; the page's loading, populated, conflict, forbidden, and empty states are covered by jsdom page tests instead.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run typecheck:database && npm run test:admin && npm run test:database && npm run build:admin` exited 0 (admin 81 tests pass / 0 fail; database 54 tests pass / 0 fail). `npm run scan:framework-standards:ratchet` reported 0 new findings and 0 grown oversized modules. `npm run test:contracts` passed 56/56 (including the four new backlog-derivation tests) and `npm run typecheck` passed for `@packscout/contracts`, `@packscout/services`, and `@packscout/worker`.
