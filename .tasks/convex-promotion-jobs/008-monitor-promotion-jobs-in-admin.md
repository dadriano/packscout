# Task: Monitor Distributed Promotion Jobs in Admin

**ID:** convex-promotion-jobs/008
**Depends on:** convex-promotion-jobs/006, convex-promotion-jobs/007, distributed-canonical-warehouse/022
**Blocks:** convex-promotion-jobs/009
**Status:** todo
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Add a read-only Admin Promotion Jobs section where operators can understand
provider-local publication, central activation, liveness, and partial outages
without receiving mutation or routing authority.

## Requirements

### Navigation and frame

- Add **Promotion Jobs** under Data pipeline at `/promotion-jobs` and opaque
  detail `/promotion-jobs/:monitoringId`; document title is
  **Convex Promotion Jobs**.
- Show it only with `providers:view`; server authorization remains
  authoritative for deep links.
- Explain that the page observes provider PostgreSQL-to-Convex publication and
  central manifest activation and does not control the scheduler.
- Refresh each section every 15 seconds only while visible, with manual refresh.
  Retain last safe evidence only for the identical scope/filter/detail after
  failure and announce staleness.

### Current state

- Lead with the central manifest coordinator: schedule/wake/invocation,
  active/previous manifest, serialized per-provider gate work, queue age,
  operation/retry/CAS evidence, and last activation/reconciliation.
- Render one row per dynamic roster provider with lifecycle, schedule health,
  evidence source/staleness, local settled/completed publication state, central
  active selection, pending gate, attempt/retry, and latest invocation.
- Distinguish provider unavailable, last-known, archived, disabled-but-still-
  active, awaiting activation, central manifest unavailable, evaluator stale,
  and roster change without erasing healthy rows.
- Never show an all-provider readiness/common-epoch banner.
- Link only trusted provider key to Published Data and safe alert references to
  occurrence/detail destinations.

### History, detail, and accessibility

- URL filters accept `manifest | provider:<providerKey>`, trigger, outcome, and
  cursor. Invalid values stay visible with one reset action and never broaden
  scope silently.
- Show bounded newest-first history and safe detail with at most 25 attempts and
  25 operations per attempt, totals, truncation, and digests.
- No provider UUID, organization/deployment, database target, raw local
  invocation ID, credential, key ID, request/response/receipt body, or claim
  appears in URL, copy, analytics, or rendered evidence.
- Provide distinct loading, empty, pending, running, no-change, continuation,
  retry, overdue, alerting, blocked, failed, forbidden, missing, rate-limited,
  stale, and unavailable states.
- Use semantic headings/tables/definition lists/time, textual status independent
  of color, polite live announcements, keyboard focus, and no page-level
  overflow at narrow or desktop widths.
- Provide no run, retry, cancel, pause, schedule, credential, configuration,
  activation, removal, rollback, or clear control.

## Acceptance Criteria

- [ ] Navigation/title/breadcrumb/permission work for both authorized roles.
- [ ] A dynamic roster renders each provider exactly once.
- [ ] One provider outage or last-known row does not blank healthy rows.
- [ ] Disabled retained-active, archived last-known, awaiting activation, and
  independent gate advance are visually and textually distinct.
- [ ] Manifest add/advance/remove/rollback updates only the selected row.
- [ ] Stale evaluator marks liveness judgments last-known without erasing
  publication facts.
- [ ] Filters survive reload/share; changing scope resets pagination safely.
- [ ] Alert and Published Data links carry only the trusted safe key or opaque
  monitoring ID.
- [ ] Visible polling, hidden-tab pause, manual refresh, request-race handling,
  429 cadence, and exact-scope stale retention are tested.
- [ ] Keyboard, focus, accessible names/live regions, textual badges, narrow and
  desktop layouts pass.
- [ ] The rendered surface contains no mutation affordance or protected field.

## Verification

Run Admin route catalog/permission tests, API/hook polling and race tests,
component/page fixtures for live/last-known/unavailable/lifecycle/gate/evaluator
states, alert/cross-link tests, axe/keyboard checks, narrow and desktop browser
verification, Admin lint/test/typecheck/build, and `npm run verify:framework`
at the group gate.

## Spec Compliance

The UI renders server judgments and never derives tenancy, routing, liveness, or
checkpoint comparisons.
