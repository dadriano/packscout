# UX Spec: Provider Configuration and Health

**Spec ID:** ux-002  
**Related tasks:** [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/011](011-manage-providers-in-admin.md)  
**Depends on UX specs:** [ux-001](ux-001-authentication-and-operator-access.md)  
**Spec status:** draft

## Purpose

Define how administrators create, test, activate, inspect, edit, disable, and archive one data provider per platform while data operators can understand provider status without seeing secrets or unsafe diagnostics.

## User Goals and Success Criteria

- An admin can configure a provider through a small sequence with clear prerequisites and no hidden activation.
- An operator can distinguish lifecycle, freshness, and data quality at a glance.
- A failed connection test identifies a safe corrective action without leaking credentials or full upstream responses.
- Editing an active provider creates a reviewable draft and does not silently change the running configuration.
- The interface prevents overlapping active providers for one platform and explains conflicts plainly.

## Current UX Context

The admin shell already supports grouped sidebar navigation, large editorial page headers, compact metric rows, ledger-style lists, status badges, dialogs, confirmations, toasts, and light/dark themes.

Provider management should extend those patterns rather than introduce a separate dashboard visual system. The UI must remain usable for operational scanning, with detailed configuration shown only when selected.

## Information Architecture and Navigation

### Routes

- `/providers` sits under a new “Data pipeline” navigation group.
- `/providers/new` is an admin-only configuration route.
- `/providers/:providerId` is the stable provider detail route for summary, configuration, health, and history.
- `/providers/:providerId/edit` creates or replaces a draft revision without mutating the active revision.

### Provider detail hierarchy

Lead with provider name/platform, lifecycle badge, freshness badge, quality badge, and the most important action. Follow with current configuration, latest import, health evidence, draft/revision state, and audit history.

Keep freshness and quality as separate labelled values. Never collapse them into one ambiguous red/yellow/green “health” score.

## Interaction Model

### Create and activate

1. Choose an unconfigured platform and enter display name, endpoint, adapter, authentication mode, schedule, and stale threshold.
2. If bearer authentication is selected, enter a credential that is masked after submission and never echoed back.
3. Save as draft, then run “Test connection” for that exact revision.
4. Review the sanitized test result and activate only after success.
5. Activation confirms the platform, schedule, endpoint host, and replacement impact before committing.

### Edit active configuration

“Edit configuration” opens a new draft based on safe active values. Secret fields show “Credential stored” and remain blank unless the admin intentionally replaces the credential.

After saving, the active revision continues running. The detail page shows a clear “Draft changes” notice with Test, Review changes, Discard draft, and Activate actions.

### Disable and archive

Disable stops future schedules and prevents another page request after current safe progress. It requires a consequence-focused confirmation. Archive is available only for disabled providers with no active work and removes the provider from default views without deleting history.

## Layout and Responsive Behavior

### Provider list

Use a page header, compact filter row, then a ledger/table with Platform, Provider, Lifecycle, Freshness, Quality, Last success, and Next run. Avoid a separate card per provider.

At 860px and below, each provider becomes a labelled stacked row with lifecycle/freshness/quality grouped near the name. Filters wrap in logical order, and the row's detail link remains the primary target.

### Configuration form

Use one readable column with grouped sections: Source, Authentication, Schedule, and Review. Place explanatory copy directly beside unfamiliar inputs such as adapter and stale threshold.

At 620px and below, actions stack full width in safe order. Never place Activate immediately beside Disable with equal visual weight.

## States and Feedback

### List states

- Loading: preserve headings and filter controls with skeleton rows.
- Empty: “No data providers configured” plus Add provider for admins.
- No filter matches: show the active filters and “Clear filters.”
- Stale data: keep rows visible and label when status was last updated.
- Failure: inline retry with prior safe data retained when available.

### Configuration and test states

- Draft: neutral badge and explicit “Not used for imports.”
- Testing: disable revision changes and show “Testing connection…” with non-blocking progress.
- Test passed: show timestamp, endpoint host, latency, and “Ready to activate.”
- Test failed: show normalized category, corrective guidance, request ID, and “Run test again.”
- Conflict: refresh active/draft versions and require the admin to review changes before retrying.

### Lifecycle states

Use literal badges for Draft, Tested, Enabled, Disabled, and Archived. Freshness uses Current, Approaching stale, Stale, and No successful data. Quality uses Healthy, Needs review, Degraded, and No evidence.

## Accessibility

- Every lifecycle, freshness, and quality state includes text and supporting evidence, not color alone.
- Endpoint, schedule, and credential inputs have visible labels, field-level help, and linked errors.
- Connection-test results use a focused summary on failure and a polite live announcement on completion.
- Confirmation dialogs identify the provider, platform, and consequence in the accessible title/description.
- List rows remain navigable with keyboard and do not turn the entire row into an inaccessible nested control cluster.

## Visual Design Direction

Use the existing operations-ledger language: dense rows, uppercase metadata, precise timestamps, strong typography, and limited status color. Provider pages should feel like configuration records, not marketing cards.

Use amber for the primary action and warnings, red only for destructive or failed states, green for confirmed success, and neutral paper/pine surfaces for routine status. Do not use color gradients or decorative charts for freshness.

## Content and Microcopy

### Primary copy

- Page title: “Data providers”
- Empty title: “No provider feeds are configured.”
- Add action: “Add provider”
- Test action: “Test connection” / pending: “Testing connection…”
- Activate action: “Activate revision”

### Safety copy

- Stored secret: “Credential stored. Leave blank to keep it unchanged.”
- Test success: “Connection passed. This revision is ready to activate.”
- Test failure: “PackScout reached the provider but couldn't validate the feed.”
- Disable title: “Disable {provider}?”
- Disable consequence: “Scheduled imports will stop. Existing history and run records will remain.”

## Design System and Component Notes

- Reuse `PageHeader`, `StatusBadge`, `AdminDialog`, `ConfirmProvider`, `ToastProvider`, and ledger styles.
- Extend `StatusBadge` tones only if existing ready/pending/danger/neutral cannot express required text hierarchy; literal labels carry the meaning.
- Add shared form-field, masked-secret, filter-row, definition-list, and revision-diff patterns.
- Use `danger` confirmation for Disable and a standard confirmation for Activate; archive can use danger only if product semantics treat it as destructive.
- Keep provider forms route-based so draft state, refresh, and browser navigation remain predictable.

## Cross-Spec and Technical Dependencies

Authentication and permissions follow [ux-001](ux-001-authentication-and-operator-access.md). Provider behavior depends on the immutable revision, secret, connection-test, and one-active-provider contracts in [tech-002](tech-002-provider-feed-storage-and-history.md) and the routes in [tech-005](tech-005-admin-api-and-operability.md).

Health evidence depends on separate freshness and quality projections from [tech-003](tech-003-ingestion-orchestration-and-reliability.md). The UI must display the server's evaluated state, not recalculate operational thresholds in the browser.

## QA and Review Checklist

- Test create, draft, secret keep/replace, test pass/fail, activate, edit active, conflict, disable, archive, and no-overlap platform conflict.
- Test admin mutations and data-operator read-only behavior, including direct route access and refreshed permission changes.
- Test list loading, empty, filtered empty, stale, partial, failure, and retained-data retry states.
- Test keyboard forms, dialog focus, error summary, connection-test announcements, confirmation, and status semantics.
- Test desktop ledger, 860px stacked rows, 620px actions, long provider names, long hostnames, zoom, and both themes.

## Open Questions and Risks

- Confirm whether archive is needed at launch or whether Disabled plus default filtering is enough.
- Confirm the exact allowed schedule bounds and whether the UI should offer common presets around the five-minute default.
- Decide whether endpoint path/query should be visible to data operators or only the safe hostname.
- Connection-test error categories and corrective copy need final normalization from the technical contract.

## Handoff Notes

Prototype the provider detail and revision states with real contract DTOs before polishing the form. The most important UX distinction is active configuration versus draft configuration; never let an edit appear immediately live.
