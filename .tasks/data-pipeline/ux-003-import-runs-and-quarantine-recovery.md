# UX Spec: Import Runs and Quarantine Recovery

**Spec ID:** ux-003  
**Related tasks:** [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/012](012-operate-imports-in-admin.md)  
**Depends on UX specs:** [ux-001](ux-001-authentication-and-operator-access.md), [ux-002](ux-002-provider-configuration-and-health.md)  
**Spec status:** draft

## Purpose

Define an operational workspace where authorized users can understand import progress, request safe manual runs, diagnose incomplete or failed work, inspect quarantined records, and retry only the affected records without raw-payload or secret exposure.

## User Goals and Success Criteria

- An operator can tell whether each provider is current, importing, incomplete, or failed.
- An operator can open a run and understand durable progress, counts, cursor status, and the safest next action.
- A permitted operator can request a manual import without creating duplicate concurrent work.
- An operator can understand why a record was quarantined and whether its source evidence remains retryable.
- Single and bulk retries clearly behave independently from provider cursor progress.

## Current UX Context

The admin overview already uses compact metrics and ledger rows to communicate system state. Run and quarantine views should build on those patterns with dense, readable evidence and progressive disclosure.

The product explicitly excludes raw JSON and secrets from the admin. Diagnostic UX therefore depends on stable normalized reason codes, safe field paths, counts, timestamps, source identifiers, and request/run references.

## Information Architecture and Navigation

### Routes

- `/runs` lists imports across providers under “Data pipeline.”
- `/runs/:runId` shows one run's trigger, lifecycle, page progress, counts, interruption, and related quarantine.
- `/quarantine` lists unresolved and historical quarantined records with safe filters.
- `/quarantine/:quarantineId` shows reason, evidence lifetime, attempts, and resolution without raw JSON.

### Cross-navigation

Provider detail links to its latest run and filtered history. Run detail links back to the provider and to quarantined records created during that run. Quarantine detail links to the originating run and safe canonical/source identifiers.

Preserve active filters in list URLs so operators can share and return to an operational view.

## Interaction Model

### Manual import

“Run import” appears on provider detail and optionally on the run list after selecting a provider. Confirmation summarizes provider, platform, active revision, starting behavior, and the one-run-at-a-time rule.

If a run is already queued or running, the action returns that run and shows “An import is already in progress. We opened the active run.” It is not styled as an error.

### Run detail

Lead with state and next action. Show requested/started/last-progress/finished times, trigger, configuration revision, durable cursor state, page and record counters, quarantine totals, and safe failure information.

Running pages update through bounded polling. Do not animate every counter. Pause polling when the page is hidden and announce only material state changes.

### Quarantine retry

Single retry confirms the record kind, provider, reason, source-expiry state, and independent retry behavior. Bulk retry begins with explicit filters, previews the bounded match count, then confirms the number of jobs that will be queued.

Resolved records remain visible in history. “Expired” means raw evidence is gone and retry is unavailable; it does not imply the record was corrected.

## Layout and Responsive Behavior

### Run list and detail

Use a filter row plus ledger/table for Provider, Trigger, State, Started, Progress, Quarantine, and Duration/outcome. The detail page uses a small metrics strip followed by one primary timeline/ledger and a diagnostic definition list.

At 860px and below, list rows become stacked records and detail metrics wrap without reordering state before provider identity. At 620px and below, filters collapse into an accessible dialog or disclosure and actions become full width.

### Quarantine list and detail

Use dense rows for Source ID, Provider, Kind, Reason, State, Created, and Retry availability. Long field paths and summaries wrap inside their column and never force page scrolling.

Detail pages use labelled evidence sections rather than code blocks. Raw values, request headers, and full provider payloads are never rendered, even behind a disclosure.

## States and Feedback

### Run states

- Queued: “Waiting for a worker” plus requested time and trigger.
- Running: last committed page/cursor evidence and “Import in progress.”
- Succeeded: terminal counts, finish time, freshness update, and any quarantine warning.
- Incomplete: durable progress retained, interruption reason, and expected automatic/manual recovery.
- Failed: non-retryable reason, configuration/provider action, and request ID where useful.

### Quarantine states

- Open: safe reason and Retry action if source evidence is retained.
- Retrying: prevent duplicate retry, show queued/running attempt state, and preserve prior evidence.
- Resolved: show resolution time, attempt, and linked canonical outcome when available.
- Expired: show “Source evidence expired; this record can't be retried.”
- Retry failed: retain open state, add the latest safe reason, and permit another attempt only when retryable.

### Page-level feedback

Loading preserves filters and headings. Empty states distinguish no history, no quarantines, and no filter matches. Dependency failure retains prior safe data with a stale timestamp when possible.

## Accessibility

- State changes are announced politely; terminal failure or an explicitly requested retry failure uses an assertive error message.
- Polling does not steal focus, reorder focused content, or announce every numeric change.
- Progress includes text and counts, not only a visual bar or spinner.
- Filters have programmatic labels, selected values, removable chips where used, and a keyboard-accessible clear action.
- Confirmation returns focus to the initiating control or the updated record after completion.

## Visual Design Direction

Treat runs as an operations ledger: timestamps, identifiers, counts, and outcome text are primary. Use status color sparingly, with amber for incomplete/review, red for failed/unavailable, green for succeeded/resolved, and neutral for queued/running context.

Avoid terminal-style raw logs and decorative live charts. The interface should support quick diagnosis without pretending the admin is a general observability platform.

## Content and Microcopy

### Run copy

- Page title: “Import runs”
- Manual action: “Run import” / pending: “Requesting import…”
- Deduplicated message: “An import is already in progress. We opened the active run.”
- Incomplete summary: “Progress was saved, but the feed did not finish.”
- Failed summary: “The import stopped and cannot retry automatically.”

### Quarantine copy

- Page title: “Quarantine”
- Empty success: “No records need review.”
- Retry action: “Retry record” / pending: “Queueing retry…”
- Bulk action: “Retry matching records”
- Independence note: “Retries process these records only. They do not rewind the provider cursor.”

## Design System and Component Notes

- Reuse `PageHeader`, `StatusBadge`, `EmptyState`, `ConfirmProvider`, and `ToastProvider`.
- Add shared keyset pagination, filter disclosure, compact timeline, metric definition, and safe diagnostic-summary patterns.
- Extend status labels with exact run/quarantine text while retaining existing tones.
- Use standard confirmation for manual import and retry; use stronger confirmation for a large bulk operation if the bound approaches its maximum.
- Keep polling and filter state in page-specific hooks, with request cancellation through the existing API client pattern.

## Cross-Spec and Technical Dependencies

Permissions follow [ux-001](ux-001-authentication-and-operator-access.md), and provider identity/health follows [ux-002](ux-002-provider-configuration-and-health.md).

Run lifecycle, cursor durability, exclusivity, quarantine independence, retention, and freshness behavior come from [tech-003](tech-003-ingestion-orchestration-and-reliability.md). Safe API fields and retry routes come from [tech-005](tech-005-admin-api-and-operability.md).

## QA and Review Checklist

- Test queued, running, succeeded, incomplete, failed, recovered, deduplicated manual request, and stale polling behavior.
- Test quarantine open, retrying, resolved, expired, retry failed, single retry, bounded bulk retry, and zero-match confirmation.
- Test admin/data-operator permissions, session expiry during polling, cross-organization denial, and refreshed role changes.
- Test list loading, empty, filtered empty, retained stale data, partial counters, pagination, and dependency failure.
- Test keyboard filters, confirmations, polling announcements, responsive rows, long IDs/field paths, zoom, and both themes.

## Open Questions and Risks

- Confirm whether data operators may request manual imports and quarantine retries or whether one/both remain admin-only.
- Define polling intervals and when to switch to manual refresh for old terminal runs.
- Set the maximum bulk-retry preview and job count before copy and confirmation strength are finalized.
- Sanitized diagnostics must be useful enough to act on; test them with actual provider failure categories before launch.

## Handoff Notes

Build run detail before the aggregate dashboard because it defines the operational evidence model. Quarantine recovery must consistently say that retries are record-scoped and never alter cursor history.
