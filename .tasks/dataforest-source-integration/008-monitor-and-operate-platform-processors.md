# Task: Monitor and Operate Platform Processors

**ID:** dataforest-source-integration/008
**Depends on:** dataforest-source-integration/007
**Blocks:** dataforest-source-integration/010
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including admin routes, progress views, controls, log feeds, accessibility, and browser verification
**Status:** done

## Start Here

Render deterministic summaries for the shared connection and four platform processors, then prove an administrator can identify which provider is catching up, which is waiting, and which failed without seeing a credential, full cursor or vendor cursor, or another provider's diagnostic event.

## Objective

Give administrators and data operators one safe admin workspace to configure, monitor, diagnose, and control all four platform processors.

## Context

PackScout already has provider configuration, provider detail, run history, run detail, health, alerts, manual imports, and quarantine workflows. This task extends those surfaces around generic provider-source summaries rather than creating a second operations application or a DataForrest-only processor console.

The UI must distinguish shared connection impact from source-local state. It must also distinguish viewing a log feed from controlling a processor: pausing log refresh never pauses ingestion, and the admin app cannot start or stop the local worker process.

## Requirements

### Overview

- Show one DataForrest connection summary with endpoint host, masked credential status, last or recovery test, shared health generation and blocking episode, live supervisor state, execution slots used and maximum, and request permits used and maximum.
- Show one row each for Courtyard, Collector Crypt, Phygitals, and ClutchPacks with source type, source and mapper revisions, lifecycle, processor activity, normalized continuation, sync phase, freshness, quality, interval, next due time, last progress, and head time.
- Show pages, records by source stream, dispositions, throughput, elapsed time, retry count, open quarantine, active run, lease age, and an explicit wait reason.
- Present percent complete or ETA only when a provider-specific total is defensible; otherwise show `Total unknown` with records, throughput, and elapsed time.
- Make a shared connection failure visible once at connection level and on affected rows without replacing each provider's local cursor, quality, or lifecycle state.

### Provider detail and diagnostics

- Present source type, source and normalized-contract revisions, mapper version, identity namespace, masked adapter-validated configuration, safe cursor fingerprint, schedule, current run, run history, page progress, quarantine summary, and health history.
- Provide one chronological diagnostic feed scoped to the selected source plus explicitly labeled shared connection events; never include another source's local events.
- Refresh current state and recent diagnostics every five seconds while the page is visible, and let the operator pause display refresh without changing ingestion.

### Diagnostic history and filtering

- Support severity, phase, and run filters plus bounded keyset pagination for older events; a run filter shows only matching run and page events and labels lifecycle, test, and connection events as hidden until the filter is cleared.
- Return a stable history-expired result and current snapshot when a requested cursor has aged out; do not add regex search, arbitrary log download, or raw payload inspection.
- Link diagnostic run, test, command, and quarantine references to existing safe detail views while keeping internal correlation references opaque.

### Operational controls

- Let administrators and data operators use Run now, processor Pause, Resume, and authorized quarantine Retry with clear created, queued, coalesced, pause-requested, paused, and resumed outcomes.
- Let administrators configure the first-pass DataForrest profile and sources, rotate the credential, test the connection or source, change a provider interval, activate or disable a source, replace it, and reset its cursor under task 004's generic lifecycle rules.
- Require selected-provider impact copy and confirmation for disable, replacement, and cursor reset; never imply another provider is affected.
- Preserve form state and current safe evidence on validation, forbidden, conflict, no-worker, and upstream-test failures.
- Keep operating-system worker start, stop, scaling, and hosting controls out of the admin console.

### Source-adapter presentation

- Render source type, capability, continuation, test, health, and configuration summaries supplied by the server contract rather than branching on provider names in shared admin views.
- Show adapter-specific values only through a fixed, masked DataForrest form and safe summaries in first pass; do not add dynamic plugin installation or a universal schema-driven form system.
- Hide unregistered and test-only adapters from every production list, create flow, command, and diagnostic filter.
- Explain that replacing source type starts a new paused source at Feed start and cannot transfer the old cursor.
- Block replacement in the UI and server when mapper contract, record-ID scopes, or identity namespace is incompatible.

### Roles and security

- Require authenticated tenant-scoped read permission for connection, source, run, health, diagnostic, and quarantine views.
- Let data operators run, pause, resume, and retry under their existing permissions but deny credential, binding, interval, activation, disable, replacement, and reset changes.
- Enforce administrator-only configuration and destructive actions on the server even when a control is hidden in the browser.
- Return stable structured validation, forbidden, conflict, rate, dependency, and upstream errors and record safe audit receipts for every mutation.
- Prove diagnostic pagination and filtering cannot leak another tenant's event identifiers, connection events, sources, runs, or counts.

### Experience and accessibility

- Represent loading, empty, queued, no-live-worker, waiting-for-capacity, connection-transition-uncertain, waiting-on-connection-recovery, running, retrying, pause-requested, paused, action-required, failed, reached-head, forbidden, reconnecting, and stale-display states.
- Announce important state changes without relying on color and preserve keyboard focus through refreshes, filters, dialogs, and command completion.
- Use existing admin shell, tables, dialogs, confirmation, toast, status, and pagination patterns before adding a shared primitive.
- Keep dense processor and diagnostic views readable at supported desktop and narrow widths with no horizontal content loss.
- Run component coverage and browser smoke for overview, provider detail, log filtering, Run now, Pause/Resume, interval editing, forbidden state, and destructive confirmation.

## User-Facing Behavior

An operator can answer four questions from the overview: which processors are running, how far each has progressed, why any processor is waiting, and where to inspect its recent diagnostic feed. On provider detail, the operator can follow committed page events and retry or pause only that provider.

## Interface Contract

The admin boundary consumes registered source-type summaries, masked connection state, supervisor presence and profile-grouped capacity, provider source and mapper revisions, normalized continuation, run and page progress, health, quarantine summaries, ordered diagnostics, and safe audit receipts.

Every command returns the current masked provider state plus one stable outcome. No browser response contains a credential, authorization header, full cursor or vendor cursor, provider payload, personal identifier, transaction identity, stack trace, or another tenant's internal identifier.

## Acceptance Criteria

### Monitoring proof

- [x] The overview accurately distinguishes shared connection, supervisor, execution-capacity, request-capacity, and four independent source states.
- [x] Provider progress shows truthful records, pages, throughput, elapsed time, next due time, and either a defensible ETA or `Total unknown`.
- [x] A selected provider feed contains its own ordered events plus labeled shared events and never another provider's local diagnostics.
- [x] Diagnostic refresh, pause-display, filters, pagination, empty state, expiry gap, and failure recovery are bounded and accessible.

### Abstraction proof

- [x] Shared monitoring and controls render from source-type-neutral summaries and contain no provider-name or DataForrest transport branch.
- [x] Source type, normalized-contract version, mapper version, identity namespace, continuation, and safe cursor ownership are visible without protected adapter configuration.
- [x] Production create and replacement flows expose only `dataforrest-events-v1` and reject the test adapter, contract mismatch, and identity-namespace mismatch.

### Control and security proof

- [x] Run now, Pause/Resume, Retry, normal or recovery connection test, source test, and interval changes return exact safe outcomes and affect only the selected provider or shared profile.
- [x] Data operators can operate imports and quarantine but cannot configure sources, credentials, activation, disable, replacement, or cursors.
- [x] Direct route tests prove authentication, authorization, tenant isolation, validation, rate control, redaction, confirmation, audit, and external-request boundaries.
- [x] Component tests and browser smoke pass for primary monitoring, diagnostics, controls, failures, accessibility, and required widths.

## Verification

- `node --import tsx --test packages/contracts/src/provider-source-operations-v1.test.ts packages/services/src/provider-source-operations-service.test.ts apps/admin/server/routes/provider-source-operations.behavior.test.ts apps/admin/src/components/operations/SourceOperationsViews.test.tsx apps/admin/src/pages/SourceOperationsPages.test.tsx` — 14/14 passed in the final root review.
- `npm run verify:framework` — passed end to end, including framework and Prisma checks, zero-finding standards ratchet, all workspace lint, typecheck, and tests, tooling and volume tests, and frontend/admin production builds.
- In-app browser smoke passed at desktop and 390-by-844 widths for the exact four-row overview, source detail, five-second visible refresh, display-only pause/resume, bounded diagnostic filtering and history expiry, Run/Pause/Resume, source test, interval change, destructive confirmation, forbidden state, and zero console warnings or errors. Both widths had no horizontal overflow.
- `git diff --check` — passed.

## Spec Compliance

- Related specs reviewed: none; this feature has no `tech-*.md` or `ux-*.md` companion specs.
- Alignment: implemented the task contract and BDD scenarios through source-neutral contracts, tenant-scoped persistence and services, strict admin routes, and the existing Operations and Provider Detail surfaces.
- Divergences: none.
- Verification: the focused Task 008 anchor, canonical framework verifier, and authenticated local browser smoke listed above all pass.
