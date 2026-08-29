# Task: Observe Provider Health and Alerts

**ID:** distributed-canonical-warehouse/010
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/005, distributed-canonical-warehouse/007
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including activity relay, grouped alert lifecycle, partial outages, and admin parity
**Status:** not started

## Start Here

Write one failure-and-recovery timeline from a provider-local event through central observation, alert opening, acknowledgement, resolution, and reopen, including behavior when the provider later becomes unreachable.

## Objective

Give operators a durable central history of provider updates and actionable alerts without making central observations authoritative for provider execution.

## Context

Provider databases own runtime truth. They relay safe activity to `packscout` on a best-effort basis so the admin can show historical updates across providers. `PROVIDER_HEALTH` is a cached observed read model; every value carries an observation time and may become stale. `ADMIN_ALERTS` owns durable acknowledgement and resolution even when a local run or quarantine record is unreachable.

This task preserves `/alerts`, `/alerts/:id`, central overview health, and protected operational health behavior. Provider detail remains a bounded direct provider read rather than a central claim of current authority.

## Requirements

### Activity and health

- Store append-only `PROVIDER_ACTIVITY_EVENTS` with provider ID, event type, severity, dedupe and recovery keys, safe run or quarantine soft IDs, bounded title, summary and evidence, event time, and received time.
- Store one cached `PROVIDER_HEALTH` projection per provider with observed runtime, freshness, quality, failure, recovery, quarantine, runner heartbeat, direct-probe, and publication-lag facts.
- Label every health response with observation time and staleness; missing or stale observation never becomes a false healthy or empty result.
- Relay activity idempotently, tolerate duplicate delivery, and resume after central outage without blocking local provider commits.
- Keep provider-local diagnostics authoritative for detailed run and recovery investigation.

### Alert lifecycle

- Group matching activity into organization-scoped `ADMIN_ALERTS` using stable dedupe and recovery identities, first and last seen times, occurrence count, severity, and safe local soft references.
- Support `active`, `acknowledged`, and `resolved` states with actor and time audit; resolving never deletes history.
- Reopen a resolved alert when new matching evidence arrives and increment its reopen and occurrence counts.
- Preserve alert validity when a referenced local run or quarantine record is missing, retained away, or unreachable.
- Bound occurrence history and sanitize all evidence before central persistence or browser delivery.

### Admin behavior

- Preserve alert list filters, stable pagination, detail history, provider/run/quarantine navigation, acknowledge, resolve confirmation, and reopen presentation.
- Carry provider ID with every local run and quarantine soft reference and drill-down query; missing provider context never triggers a provider-database scan.
- Require provider viewing permission for reads and trusted Origin plus CSRF for acknowledge and resolve mutations.
- Show healthy provider activity even when another provider is unreachable and show unreachable or stale rows explicitly.
- Preserve loading, empty, filtered-empty, stale, unavailable, forbidden, not-found, acknowledged, resolved, reopened, and mutation-failure states.
- Keep status, severity, staleness, and action outcomes accessible through text, focus handling, keyboard controls, and live announcements.
- Use the shared admin error compatibility matrix for alert, health, permission, conflict, not-found, rate-limit, and provider-unavailable outcomes.

### Observation safety

- Never treat central activity delivery as part of a provider page, cursor, command, or publication transaction.
- Never store credentials, connection strings, raw cursors, raw payloads, unsafe account identities, or database error bodies in health, activity, alerts, or audits.
- Use bounded retries and backpressure so central outage cannot exhaust provider storage or worker resources.
- Expose metrics for activity lag, health staleness, runner heartbeat, reachability, alert age, quarantine count, and publication lag.
- Record acknowledge, resolve, reopen, delivery failure, and recovery as central audit events.

## User-Facing Behavior

Operators see when each provider was last observed, whether the reading is stale, and which provider needs mitigation. They can acknowledge or resolve grouped alerts without losing history. New matching evidence reopens a resolved alert. A missing or unreachable local target leaves the alert readable and clearly marks the unavailable drill-down.

## Interface Contract

A provider observation contains provider ID, source database identity, observed state, freshness, quality, safe counts and failure, event time, received time, and staleness. It never claims local transactional authority.

An alert projection contains organization and provider IDs, state, type, severity, dedupe and recovery keys, safe title and summary, occurrence and reopen counts, first and last seen times, acknowledge and resolve metadata, and optional provider-qualified local soft references.

## Acceptance Criteria

### Observation acceptance

- [ ] Provider activity delivery is idempotent, resumes after central outage, and never blocks a provider commit.
- [ ] Every health result includes observation time and staleness, and stale or missing data never appears healthy by default.
- [ ] One unreachable provider leaves healthy provider history and alert operations usable.
- [ ] Provider-local detail remains authoritative and returns an explicit unavailable result when unreachable.
- [ ] Metrics cover reachability, heartbeats, activity lag, quarantine, publication lag, and alert age.

### Alert acceptance

- [ ] Matching events group into one alert with accurate occurrence counts and bounded history.
- [ ] Acknowledge, resolve, and reopen preserve actor, time, history, role, Origin, CSRF, and audit behavior.
- [ ] Alert state remains exactly `active | acknowledged | resolved`, and matching evidence reopens a resolved alert to `active`.
- [ ] Missing or unreachable run and quarantine soft references do not corrupt the central alert.
- [ ] Alert list, detail, navigation, confirmation, partial, and failure states remain accessible.
- [ ] Every run or quarantine drill-down carries provider context and never scans provider databases.
- [ ] No protected provider, credential, cursor, payload, actor, or database-error data appears centrally or in the browser.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Provider activity is relayed from the local outbox as best-effort observation; central alerts remain durable but non-authoritative.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
