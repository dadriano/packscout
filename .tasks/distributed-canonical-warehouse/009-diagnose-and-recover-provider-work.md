# Task: Diagnose and Recover Provider Work

**ID:** distributed-canonical-warehouse/009
**Depends on:** distributed-canonical-warehouse/005, distributed-canonical-warehouse/007, distributed-canonical-warehouse/008
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including quarantine parity, bulk retry, retention evidence, and recovery failures
**Status:** in progress

## Start Here

Map each current quarantine list, detail, retry, expired-evidence, and partial bulk outcome to its provider-local record and attempt history, then identify the immutable run fields that recovery must never change.

## Objective

Let authorized operators diagnose and retry individual failed records without rewinding the provider cursor, reopening a historical run, or exposing protected evidence.

## Context

Quarantine belongs to the provider database because it is part of the page transaction and provider recovery state. Central admin identity authorizes the operation, then the admin server connects directly to the provider database. Each retry has independent history and outcome; resolution changes current quarantine state but never rewrites the originating run's immutable counters or terminal outcome.

This task preserves `/quarantine` and `/quarantine/:id` and includes the current run-detail links, safe evidence lifetime, retry-attempt history, retention history, and bounded local audit view needed for mitigation.

## Requirements

### Quarantine inspection

- Preserve current provider, run, state, record-kind, and reason filtering with a versioned composite cursor and deterministic cross-provider order.
- Show run and page position, reason code, field path, sanitized summary, evidence lifetime, retry count, current state, resolution summary, and attempt history; always return `externalId: null` to the browser.
- Never expose full provider payloads, raw cursors, unsafe actor identifiers, credentials, or unbounded validation details.
- Keep expired records visible and unselectable, with explicit text that expiration does not mean correction.
- Return a bounded unavailable state when the selected provider database cannot be reached.

### Retry behavior

- Permit one-record retry and bulk retry of 1–50 unique `{ providerId, quarantineId }` targets across one or more providers.
- Require `imports:retry`, trusted Origin, CSRF, organization ownership, provider ownership, and an idempotent correlation key.
- Record a `QUARANTINE_ATTEMPT` as `running`, then terminalize it as `succeeded` or `failed`; report request outcomes separately as `resolved`, `failed`, `already_retrying`, `already_resolved`, `expired`, or `not_found`.
- Commit a successful canonical mutation, promotion change, quarantine resolution, attempt outcome, and local audit atomically.
- Group bulk work by provider under bounded concurrency and report each target independently; an unreachable provider group fails safely while successful groups commit, with no cross-provider transaction.

### Recovery invariants

- Never rewind or advance the provider source cursor during quarantine retry.
- Never update the originating page counters, run counters, run state, run terminal time, or run failure outcome.
- Use the current canonical row version and current provider configuration when validating a retry; stale evidence fails safely.
- Keep evidence retention and purge executions from deleting unresolved, active-retry, or audit-required records before their policy permits.
- Record retention outcome, retry outcome, actor soft reference, and shared correlation ID in local audit without protected evidence.
- Carry provider ID in every run, quarantine, attempt, and alert drill-down; `/quarantine/:quarantineId?providerId=<providerId>` is required and never triggers a provider-database scan.

### Accessible outcomes

- Preserve loading, empty, filtered-empty, forbidden, not-found, expired, retrying, resolved, failed, partial-success, and provider-unavailable states.
- Announce bulk completion counts and each failed item through accessible text.
- Preserve filter and selection state after a recoverable request failure.
- Require confirmation before retrying one or many records and return focus to the initiating control.
- Use state text and guidance rather than color-only badges.

## User-Facing Behavior

An operator can inspect safe evidence, retry one record or up to 50 selected records, and see a separate result for each. A successful retry changes the quarantine's current state but the original run still reports what happened at import time. Expired evidence remains visible for history but cannot be retried.

## Interface Contract

A safe quarantine projection contains provider, run and page soft IDs, record position and kind, `externalId: null`, reason, field path, summary, evidence dates, state, retry count, resolution, and bounded attempt summaries.

A bulk retry request contains 1–50 unique `{ providerId, quarantineId }` targets and one idempotent correlation key. The server groups requests by provider, returns one outcome for every target plus provider reachability, and never opens a cross-provider transaction.

## Acceptance Criteria

### Recovery acceptance

- [ ] Quarantine list and detail preserve current filtering, pagination, safe evidence, lifetime, attempts, and accessible states.
- [ ] One-record and 1–50 record retries enforce permission, ownership, CSRF, Origin, uniqueness, and idempotency.
- [ ] Bulk retry returns independent outcomes for resolved, failed, already retrying, already resolved, expired, and missing records.
- [ ] Attempt rows use `running | succeeded | failed`, independently from the request outcome vocabulary.
- [ ] A successful retry atomically updates canonical state, promotion changes, quarantine state, attempt history, and local audit.
- [ ] Expired evidence remains visible but cannot be selected or retried.

### History acceptance

- [ ] Retry never moves the provider cursor or mutates the originating run or page outcome.
- [ ] Unreachable provider behavior is bounded and does not affect quarantine access for another provider.
- [ ] A cross-provider selection fans out by provider, keeps successful groups, and reports unreachable groups per target.
- [ ] Retention cannot purge unresolved or active-retry evidence ahead of policy.
- [ ] Browser, log, audit, and alert output contain no raw cursor, payload, credential, or unsafe actor identity.
- [ ] Run-to-quarantine and quarantine-to-run navigation works after successful, failed, and expired retries.
- [ ] Every local drill-down requires provider context, and browser quarantine projections always return `externalId: null`.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Retry operates from the provider-neutral normalized candidate and never rewrites the original page, run, or cursor.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
