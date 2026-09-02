# Task: Expose Distributed Promotion Job Monitoring

**ID:** convex-promotion-jobs/007
**Depends on:** convex-promotion-jobs/001, convex-promotion-jobs/006, distributed-canonical-warehouse/010
**Blocks:** convex-promotion-jobs/008
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Expose safe, bounded monitoring for a dynamic provider roster and one central
manifest coordinator while preserving provider outage isolation and separating
schedule, publication, and activation facts.

## Requirements

### Overview

- Return roster observation/version/digest/count, evaluator state, one central
  manifest view, and one provider view for every trusted roster row.
- Evaluated job count is roster schedule count plus one.
- Read live provider state through the bounded gateway after central
  organization/provider authorization. Return evidence source
  `live | last_known | unavailable`, observation time, staleness, and a safe
  route failure.
- Gateway failure retains only the last sanitized central projection and never
  fabricates healthy/current evidence.
- All live provider probes share one 15-second overview deadline. Once that
  budget expires, no queued probe starts and every remaining row falls back to
  its sanitized central evidence.
- Provider view separates local schedule, settled/completed/retry state, central
  active manifest selection, pending activation, and lifecycle.
- Manifest view is central-only: active/previous manifest, serialized operation,
  per-provider gate queue depth/oldest age, last activation/reconciliation,
  schedule/wake/invocation, and no global epoch/readiness judgment.

### History and detail

- Provider invocations remain local and emit idempotent sanitized summary/detail
  projections centrally. Manifest invocations originate centrally.
- Return one central keyset page ordered newest by
  `(startedAt, monitoringId)`, default 25 and maximum 100.
- Filters are exactly `manifest | provider:<providerKey>`, trigger, and terminal
  outcome. Omission means all. Reject `all`, UUIDs, database names, aliases,
  unprefixed keys, and cursor/filter mismatch.
- Cursor is integrity-bound to organization, deployment, roster digest, filters,
  and position.
- Detail accepts only an opaque central monitoring ID. Cross-scope and missing
  are indistinguishable.
- Return at most 25 attempt snapshots and 25 recent safe operations per attempt
  with totals/truncation/full-set digests.

### Security and alerts

- Require `providers:view`; organization comes from the session and deployment
  from trusted server configuration.
- Responses are non-cacheable and overview/history/detail failures remain
  independent.
- Exclude raw local routing IDs, request/response/receipt bodies, credentials,
  key IDs, claims, database topology, tenant/deployment/actor fields, canonical
  rows, and protected evidence.
- Promotion alerts may carry nullable opaque `promotionInvocationId`; top-level
  operational `runId` stays null. Attempt-only, gate, and schedule alerts link
  to the filtered overview without inventing an invocation.

## Acceptance Criteria

- [x] Dynamic add/disable/archive updates the roster exactly once without a
  hardcoded provider count.
- [x] One unavailable provider leaves healthy provider and manifest results
  readable and explicitly labels live versus last-known evidence.
- [x] A 64-provider outage returns every stable last-known row within one
  overview probe budget rather than multiplying the timeout by roster size.
- [x] Completed local release newer than central active selection reads
  `awaiting_activation`; unrelated providers remain current.
- [x] Disabled/archived providers preserve truthful retained active selection
  without being presented as live work.
- [x] One-provider gate advance updates only its provider judgment.
- [x] Provider projection replay deduplicates and exposes projection lag.
- [x] History pagination/filter/cursor tamper and cross-scope opaque IDs fail
  safely.
- [x] Detail bounds and digests remain deterministic after local source pruning.
- [x] Responses, errors, logs, and fixtures pass protected-content redaction.
- [x] Anonymous/forbidden/invalid/missing/rate-limited/unavailable outcomes use
  stable structured 401/403/422/404/429/503 behavior and `no-store`.

## Verification

Run contracts tests, provider-outbox projection replay tests, one-central/two-
provider gateway integrations, provider outage/lifecycle tests, monitoring
service judgment/cursor tests, Admin route auth/error/no-store tests,
typecheck/lint, and the standards ratchet.

## Spec Compliance

The monitoring service joins observations in memory from bounded independent
reads; it performs no cross-database query or transaction.

## Completion

The contracts, provider projections, central monitoring runtime, and Admin API
routes are implemented. Their dynamic roster, outage isolation, bounded
history/detail, authorization, structured error, and redaction checks pass.
