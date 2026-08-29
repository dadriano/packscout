# Task: Complete One Mixed-Response Provider Run

**ID:** distributed-canonical-warehouse/007
**Depends on:** distributed-canonical-warehouse/005
**Blocks:** distributed-canonical-warehouse/008, distributed-canonical-warehouse/009, distributed-canonical-warehouse/010, distributed-canonical-warehouse/013
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including page atomicity, replay, fencing, and fixture-driven verification
**Status:** in progress

## Start Here

Create one provider-neutral fixture page containing catalog entities, pulls, and market events together, then write the expected canonical, quarantine, page-counter, cursor, and promotion-change outcome for one successful commit.

## Objective

Run one provider workflow that accepts mixed canonical input, commits each page atomically, advances one provider cursor, and isolates retries or failures from every other provider.

## Context

Catalog, pull, and market-event data arrive together for a provider. They are not separate schedules, controls, cursors, leases, or admin runs. One provider may have many response pages, but every page belongs to one provider run and one checkpoint lineage.

Provider-specific fetchers, parsers, and mappers are deferred. This task defines and proves the source-neutral provider-run boundary with protected fixtures. Later adapters must produce this boundary without changing generic runtime behavior.

## Requirements

### Run lifecycle

- Create one provider-level run for `scheduled`, `manual`, or `recovery` trigger and pin its accepted provider configuration version.
- Enforce one queued or running run per provider; a duplicate idempotent request returns the existing run with `deduplicated = true`.
- Start from the provider runtime's one committed cursor and finish as `succeeded`, `incomplete`, or `failed` without rewriting the terminal outcome.
- Update heartbeat and bounded progress while running; an expired lease owner cannot update progress or terminalize the run.
- Create a new recovery run after an incomplete outcome rather than reopening historical work.

### Mixed page contract

- Accept a versioned provider-neutral page containing zero or more catalog, pull, and market-event records in one ordered response.
- Bind every page to provider ID, run ID, configuration version, input cursor fingerprint, output cursor, response digest, and head-reached state.
- Reject unknown fields, wrong-provider content, invalid version, oversized data, duplicate positions, and cursor mismatch before canonical commit.
- Count catalog, pull, and market-event records separately inside the one page and one run; do not create data-kind run identities.
- Treat a valid empty page according to its explicit continuation or head result rather than inventing a stream-specific outcome.

### Atomic page commit

- In one provider transaction, persist valid canonical mutations, immutable facts, per-record quarantine outcomes, page summary, run counters, next cursor, and ordered promotion changes.
- Advance the provider cursor only after every durable result for the page commits.
- Quarantine a record-level canonical failure with safe independently retryable evidence while allowing other valid records in the page to commit.
- Fail the whole page without cursor movement when provider identity, lease fence, page identity, or page-level contract is invalid.
- Ensure the page transaction never reads or writes the central database or another provider database.

### Replay and isolation

- Replaying the same committed page returns its prior outcome without duplicating facts, change rows, quarantine records, counters, or cursor advancement.
- A changed digest for an already committed page identity fails as an immutable conflict.
- Restart after uncertain work resumes from the last committed cursor and rejects results from the expired owner fence.
- A failed, paused, stopped, or backlogged provider does not block another provider's scheduling, page commit, or recovery.
- Verify the generic boundary with at least two provider fixtures and no provider-name branch.

## User-Facing Behavior

Operators see one provider run with mixed record counts and ordered page progress. A duplicate Run now request opens the already-active run. A record-level problem appears in quarantine while accepted records remain committed. A failed provider does not delay or erase another provider's progress.

## Interface Contract

A page input contains contract version, provider ID, run ID, configuration version, lease fence, page number, input cursor fingerprint, next cursor, continuation state, response digest, and an ordered list of typed catalog, pull, or market-event candidates.

A committed page result contains page ID, record counts by kind and disposition, quarantine IDs, material change count, resulting cursor fingerprint, reached-head state, and run progress. It contains no raw cursor, credential, unsafe provider actor, or full source payload.

## Acceptance Criteria

### Page acceptance

- [ ] One fixture page commits catalog, pull, and market-event outcomes under one run, page, cursor, and worker fence.
- [ ] Valid records, quarantines, page counters, cursor advancement, and promotion changes commit atomically.
- [ ] A page-level failure leaves canonical data, counters, change rows, quarantine, and cursor unchanged.
- [ ] An identical replay has exactly-once effect, and a changed replay digest fails as an immutable conflict.
- [ ] Unknown fields, cross-provider data, invalid versions, oversized input, and stale fences fail safely.

### Independence acceptance

- [ ] One provider has at most one queued or running run and one durable cursor.
- [ ] A duplicate manual request returns the active run instead of creating a second run.
- [ ] Incomplete recovery creates a new run and preserves the original outcome.
- [ ] Two provider fixtures progress concurrently with no shared cursor, lease, failure state, or transaction.
- [ ] No provider adapter, mapper, raw staging store, or provider-specific generic branch is introduced.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Catalog, pull, and market-event records share one page transaction, run, lease, and cursor.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
