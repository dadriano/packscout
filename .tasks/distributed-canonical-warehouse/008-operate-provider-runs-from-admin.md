# Task: Operate Provider Runs from Admin

**ID:** distributed-canonical-warehouse/008
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003, distributed-canonical-warehouse/005, distributed-canonical-warehouse/007
**Blocks:** distributed-canonical-warehouse/009, distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including current route parity, direct provider control, partial failures, and accessibility
**Status:** in progress

## Start Here

Map every current `/operations`, `/runs`, `/runs/:id`, and provider Run now state to the new provider-level runtime and identify every legacy per-stream label or control that must disappear.

## Objective

Let operators inspect and control one mixed-response run per provider through the current admin experience, with direct provider-database authority and isolated unreachable states.

## Context

The admin application remains the control surface, but `packscout` is not an offline command queue. Each protected request authenticates centrally, validates organization ownership, resolves the server-owned provider connection, and performs a bounded direct operation against that provider database.

The UI keeps one Run now action per provider. Catalog, pulls, and market events appear only as counters within that run. There are no data-kind pause buttons, stream rows, stream cursors, or aggregate runs fabricated from multiple internal runs.

## Requirements

### Operations overview

- Preserve provider freshness, quality, runtime state, schedule, current work, latest outcome, quarantine summary, recovery summary, and bounded failure presentation.
- Keep freshness and quality as separate states and show observation time for every provider result.
- Use bounded concurrent provider reads and return successful rows even when another provider is unreachable or times out.
- Preserve one flat cross-provider list using a versioned opaque composite cursor, deterministic order by event time then provider ID and local ID, and prior safe results during a transient refresh failure.
- Remove legacy stream rows, data-kind controls, and platform terminology from the new internal and UI contracts.

### Run now and runtime control

- Fail Run now before creating a provider-local command or run when the selected
  provider has no installed integration. Return the stable
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` response and keep the existing accessible
  error presentation.
- Expose one Run now action that submits provider ID, expected configuration version, expected runtime generation, and an idempotency key.
- Return `{ run, deduplicated }` and navigate to the active run whether the request created or reused it.
- Preserve provider-level pause, resume, and stop behavior through direct commands with explicit confirmation and bounded reasons.
- Require `imports:start` for Run now and the current administrator permission for provider lifecycle or runtime state changes.
- Show conflict, unreachable, forbidden, rate-limited, and accepted outcomes without retrying a mutation invisibly.

### Run list and detail

- Preserve run filtering, trigger and state filters, keyset pagination, queued/running polling, and immutable terminal outcome presentation.
- Show pinned configuration, trigger, requester, timings, safe cursor fingerprints, mixed record counters, failure code and summary, page summaries, timeline, and related quarantine links.
- Carry `providerId` with every provider-local run link and API request, including `/runs/:runId?providerId=<providerId>`; never locate a run by scanning provider databases.
- Report each page's catalog, pull, and market-event counts under one run and one page number.
- Poll only a visible queued or running detail and preserve the last safe result after a refresh failure.
- Never send raw cursors, protected evidence, database errors, connection details, or upstream payloads to the browser.

### Security and accessibility

- Validate organization ownership before resolving a provider connection and revalidate expected configuration and runtime generation locally.
- Require trusted Origin and CSRF for every mutation, strict bounded inputs, stable errors, and correlated central plus local audit.
- Preserve loading, empty, filtered-empty, stale, partial, unavailable, forbidden, conflict, success, and failure states.
- Keep filters, tables, confirmations, and controls keyboard operable with labelled fields, visible focus, and live status announcements.
- Represent every state in text rather than color alone.

## User-Facing Behavior

An operator opens the existing operations or runs area, sees one row and one current workflow per provider, and selects Run now once. If the provider already has active work, the existing run opens. If another provider is down, healthy provider rows and controls remain usable. Run detail shows mixed page counts without exposing source cursors or protected evidence.

## Interface Contract

`requestRunNow(providerId, expectedConfigVersionId, expectedRuntimeGeneration, idempotencyKey)` returns the safe run projection and `deduplicated`. Provider overview and run responses use `providerId` and `providerKey`, never database selectors or legacy stream identifiers.

Cross-provider list reads return flat deterministically ordered items, a versioned opaque composite cursor containing bounded per-provider positions, and independently typed `reachable` or `unreachable` provider results. One provider's timeout or schema mismatch cannot turn the entire response into a generic empty or failed result.

Every run list row and local soft reference carries `providerId` with `runId`. The UI route remains `/runs/:runId` and includes provider context as a required query value. Missing or invalid provider context returns the shared safe not-found contract and never triggers a database scan.

## Acceptance Criteria

### Operations acceptance

- [ ] With no installed provider integration, Run now visibly fails with
  `PROVIDER_SOURCE_ADAPTER_UNAVAILABLE` and creates no command or run.
- [x] `/operations`, `/runs`, `/runs/:id`, and provider Run now preserve current behavior under provider terminology.
- [x] One Run now request creates or reuses one provider-level run and exposes no per-data-kind controls.
- [x] Run detail shows mixed record counters, pages, safe cursors, immutable outcomes, and related quarantine links.
- [x] Cross-provider lists use deterministic merge ordering and resumable composite cursors while reporting per-provider unreachable outcomes.
- [x] Pause, resume, stop, and Run now enforce permission, Origin, CSRF, generation, idempotency, and confirmation rules.
- [x] Loading, empty, partial, unavailable, conflict, polling, and terminal states remain accessible.

### Isolation acceptance

- [x] One unreachable provider produces one bounded unavailable result while healthy provider rows and commands work.
- [x] Cross-organization and browser-selected database targets fail before a provider connection opens.
- [x] Pagination remains stable while other providers create or finish runs.
- [x] Every local run and quarantine link carries provider context, and a missing context never scans provider databases.
- [x] Raw cursors, credentials, connection details, database errors, and provider payloads never reach browser or audit output.
- [x] Current admin run and operations contract tests pass against at least two isolated provider databases.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Admin routes authorize centrally and route directly by validated `providerId`; no provider scan or offline command queue is added.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.

## Completion Evidence

- Provider operations, run list/detail, Run now, and runtime-control contracts now use provider terminology and direct bounded provider-database routing with central ownership checks.
- Signed compact composite cursors retain deterministic per-provider positions and frozen unavailable outcomes within the 8,192-byte payload limit at the 50-provider fan-out bound.
- Provider-local command and run repositories preserve one queued/active mixed run, exact idempotency, generation/fence checks, and queued-run visibility across pause, stop, and active-run races.
- Existing admin pages retain loading, empty, partial, unavailable, polling, terminal, keyboard, confirmation, and last-safe-result behavior without exposing raw cursors, credentials, connection details, errors, or provider payloads.
- The task branch passed `npm run verify:framework`; after integration, all 15 Prisma schema tests, distributed package typechecks, 8 cursor/service regressions, and 3 provider-coordination regressions passed.
