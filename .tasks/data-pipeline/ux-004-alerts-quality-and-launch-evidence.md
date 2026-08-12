# UX Spec: Alerts, Data Quality, and Launch Evidence

**Spec ID:** ux-004  
**Related tasks:** [data-pipeline/007](007-project-catalog-and-inventory-data.md), [data-pipeline/008](008-project-pulls-and-sales.md), [data-pipeline/009](009-calculate-estimated-ev.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Depends on UX specs:** [ux-002](ux-002-provider-configuration-and-health.md), [ux-003](ux-003-import-runs-and-quarantine-recovery.md)  
**Spec status:** draft

## Purpose

Define an in-admin alert and evidence experience that helps operators distinguish freshness from data quality, understand PackScout Estimated EV limitations, review launch reconciliation, and take the correct provider/run/quarantine action.

## User Goals and Success Criteria

- An operator can see which conditions need attention and why, without reading raw logs.
- Repeated occurrences group into one alert with first/last seen and occurrence count.
- Freshness, quality, relationship backlog, and EV availability remain separate concepts.
- An operator can understand how an estimated EV was produced and when it is incomplete or unavailable.
- An admin can review one platform's immutable launch scorecard before enabling incremental imports.

## Current UX Context

The admin Overview already presents three compact status metrics and a system ledger. This spec turns that foundation into an operational summary without converting it into a wall of charts or duplicating full provider/run detail.

Version one notifications live only in the admin. The UI consumes a channel-neutral event model so later delivery channels do not change alert content or operator actions.

## Information Architecture and Navigation

### Routes

- `/alerts` lists active and historical operational alerts under “Data pipeline.”
- `/alerts/:alertId` shows grouped occurrence evidence and the linked provider/run/quarantine action.
- `/launch-validations/:validationId` is an admin-only immutable scorecard reached from provider detail.
- Estimated EV explanation appears as a section on relevant operational evidence/detail, not as a new public product route.

### Overview summary

Replace foundation-only metrics when real data exists with Providers current, Providers stale, Open quarantine, and Active alerts. Keep the list bounded and link each count to its filtered source page.

Do not merge freshness and quality into a single count. One provider can be current but degraded, or stale with otherwise clean records.

## Interaction Model

### Alerts

Selecting an alert shows severity, title, safe summary, provider, first seen, last seen, occurrence count, current state, and the primary remediation link. Acknowledge means an operator has seen it; Resolve means the condition is no longer active or has been deliberately closed.

Repeated events update the existing alert without pushing duplicate rows. If a resolved condition recurs, reopen it with a visible new occurrence rather than losing prior acknowledgment history.

### Estimated EV explanation

Show the amount only with its unit and label: “PackScout Estimated EV per pack” or “per draw.” Follow with method, input recency, evidence coverage, currency treatment, and limitations.

If inventory is incomplete, show “Based on available provider odds and value evidence; this is not a complete machine inventory.” If unavailable, lead with the stable human explanation instead of displaying `$0` or a blank value.

### Launch scorecard

The scorecard is read-only after completion. It presents configuration/mapper version, cursor range, source counts, imported/deduplicated/quarantined/skipped reconciliation, unresolved relationships, EV evidence status, security proof, and failure/recovery proof.

Approval is admin-only and available only when required gates pass. Enable incremental imports is a separate confirmation so approval never silently changes schedule state.

## Layout and Responsive Behavior

### Alerts

Use a compact list with Severity, Condition, Provider, State, Last seen, and Count. Detail uses one primary action, a short evidence definition list, and a grouped occurrence ledger.

### EV evidence

Use a bordered evidence section, not a promotional card. The amount and unit are prominent, while method and limitations remain adjacent and visible without opening a tooltip.

### Launch evidence

Use a vertical scorecard with a summary strip and grouped gate sections. At desktop widths, reconciliation labels and values may use aligned columns; at 860px and below they stack as labelled rows. No section depends on horizontal scrolling.

At 620px and below, acknowledgment, resolution, approval, and enable actions stack in consequence order with sufficient separation.

## States and Feedback

### Alert states

- Active: action required or condition ongoing.
- Acknowledged: seen by an operator; condition may still be active.
- Resolved: condition closed, with actor and timestamp.
- Reopened: a resolved condition recurred and needs fresh review.
- Stale evidence: latest alert state cannot refresh; prior evidence remains labelled with its timestamp.

### EV states

- Available, exact evidence: supported inputs with no known inventory limitation.
- Available, limited evidence: amount shown with a visible limitation statement.
- Provider estimate: provider-supplied method and recency shown explicitly.
- Unavailable: reason text such as incomplete probabilities, unsupported currency, or missing values.
- Recomputing: retain prior estimate, label its timestamp, and show that new evidence is processing.

### Launch states

Use Running, Needs review, Blocked, Passed, Approved, and Incremental enabled. Blocked gates identify the source page or evidence needed to resolve them.

## Accessibility

- Severity and state always use visible text; icons and color are supplemental.
- Alert counts, timestamps, and occurrence updates have clear labels and do not announce passive refresh noise.
- EV amount is programmatically associated with unit, method, timestamp, and limitation text.
- Scorecard gates use headings and ordered structure so assistive-technology users can navigate results quickly.
- Confirmation dialogs name the provider/platform and distinguish Approve from Enable incremental imports.

## Visual Design Direction

Use the existing ledger and field-note aesthetic with strong hierarchy, sparse status color, and concise operational language. Alerts should look actionable but not alarmist; severity is proportional to consequence.

EV evidence should favor credibility over visual excitement. Avoid gauges, “good deal” colors, confidence percentages without a defined model, and any treatment that implies a complete inventory when PackScout lacks one.

## Content and Microcopy

### Alert copy

- Page title: “Operational alerts”
- Empty title: “No active alerts.”
- Acknowledge action: “Acknowledge”
- Resolve action: “Resolve alert”
- Reopened label: “Reopened after a new occurrence”

### EV copy

- Label: “PackScout Estimated EV”
- Unit: “per pack” or “per draw”
- Limited evidence: “Based on available provider odds and value evidence; this is not a complete machine inventory.”
- Unavailable: “Estimated EV is unavailable because {reason}.”
- Provider method: “Provider-supplied estimate, last updated {time}.”

### Launch copy

- Page title: “Launch validation”
- Approval action: “Approve validation”
- Enable action: “Enable incremental imports”
- Blocked summary: “This platform isn't ready to launch. Review the blocked gates below.”
- Passed summary: “Required reconciliation, failure, and security checks passed.”

## Design System and Component Notes

- Reuse `PageHeader`, `StatusBadge`, `EmptyState`, `ConfirmProvider`, `ToastProvider`, metric rows, and ledgers.
- Add alert-severity, evidence-definition, gate-result, reconciliation-row, and limitation-callout patterns.
- Use standard confirmation for Acknowledge, stronger confirmation for Resolve, Approve, and Enable when consequences warrant it.
- Keep timestamps formatted consistently with explicit timezone/relative context and expose exact values accessibly.
- Do not introduce charting dependencies for launch; counts and pass/fail evidence are clearer as structured rows.

## Cross-Spec and Technical Dependencies

Provider freshness and quality navigation follows [ux-002](ux-002-provider-configuration-and-health.md), while run/quarantine remediation follows [ux-003](ux-003-import-runs-and-quarantine-recovery.md).

Alert deduplication and notification abstraction come from [tech-003](tech-003-ingestion-orchestration-and-reliability.md). EV methods and limitation codes come from [tech-004](tech-004-canonical-projections-and-estimated-ev.md). Launch evidence and gates come from [tech-006](tech-006-provider-mappings-and-launch-verification.md).

## QA and Review Checklist

- Test active, repeated, acknowledged, resolved, reopened, stale, empty, filtered, and failure alert behavior.
- Test EV exact, limited, provider-supplied, unavailable, unsupported currency, per-pack/per-draw, and recomputing states.
- Test launch running, blocked, needs review, passed, approved, enable confirmation, and independent rollback navigation.
- Test permissions, direct routes, cross-organization denial, session expiry, confirmation focus, and live announcements.
- Test responsive evidence rows, long reasons, large counts, timezone copy, zoom, reduced motion, and both themes.

## Open Questions and Risks

- Define which event severities can be manually resolved versus only auto-resolved by healthy evidence.
- Confirm numeric launch thresholds for quarantine rate, unresolved relationships, and count reconciliation.
- Determine where operators can inspect historical EV calculations after a current estimate changes.
- Any future external notification channel must preserve the same safe content boundary and deep-link permission checks.

## Handoff Notes

Review alert and EV microcopy with actual normalized reason codes before implementation. The interface must make evidence quality visible at the same moment it shows an estimated value or launch decision.
