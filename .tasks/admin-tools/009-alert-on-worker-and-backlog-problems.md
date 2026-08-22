# Task: Alert on Worker and Backlog Problems

**ID:** admin-tools/009
**Depends on:** admin-tools/006, admin-tools/007, admin-tools/008
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

When the worker fleet goes silent, a run stalls, a schedule goes overdue, the recomputation queue backs up, or retention stops running, an operational alert is raised through the admin's existing alert system — so operators are told about machinery failures instead of having to notice them.

## Context

The admin already has an operational alert pipeline: alerts are generated server-side, carry freshness/quality/recovery context, appear in the alerts area with acknowledge/resolve lifecycles, and stay within the abstract notification boundary (no external email/webhook delivery in V1). Existing conditions cover data outcomes and retention failures (retention-failed and retention-recovered alert kinds already exist, raised by the retention service when an execution fails or recovers) — but nothing covers the machinery itself. The most dangerous failure mode — every worker dead, nothing importing — currently raises nothing.

admin-tools/006 through admin-tools/008 make the underlying conditions durable and derivable server-side. This task turns those shared derivations into alert conditions with sensible thresholds and lifecycle behavior, reusing — not forking — the existing alert generation, storage, and UI.

## Requirements

- New alert conditions, each derived from the same server-side definitions the monitoring views use (admin-tools/007, admin-tools/008), never re-derived independently:
  - fleet silence: no worker heartbeat within its threshold,
  - stalled run: a running import run whose heartbeat age exceeds its threshold,
  - overdue schedule: a provider past its next-due time beyond a tolerance,
  - recomputation backlog: queue depth or oldest-pending age past thresholds,
  - retention overdue: no successful retention execution within its expected interval. Retention *failure* alerts already exist and are not duplicated — this condition covers only the stopped-running case, and an active failure alert must not also raise an overdue alert for the same situation.
- Thresholds/tolerances are configurable through the pipeline's existing configuration approach with safe defaults; the alert states which threshold was crossed with the observed value.
- Alerts deduplicate: a persisting condition maintains one active alert rather than raising a new alert per evaluation; a condition that clears resolves or marks its alert recovered per the existing alert lifecycle, and a recurrence raises a fresh alert.
- Each alert carries bounded, actionable context — which instance, run, provider, or queue measure — sufficient to navigate to the relevant monitoring or detail view, following existing alert-detail conventions; no secrets or raw payloads.
- Fleet-silence evaluation (and any condition that must fire when no worker is alive) runs as a new bounded evaluation loop in an always-on process outside the worker — the admin server is the natural host — feeding the existing operational-event-to-alert publication path rather than forking it. Conditions that only matter while workers are alive may evaluate wherever the shared derivations live, but the fleet-silence path must demonstrably execute with zero live worker processes.
- New alert kinds appear in the existing alerts UI grouped/labelled consistently with current alerts, with acknowledge/resolve behavior unchanged.
- No external notification delivery is added; everything stays within the existing abstract notification boundary.

## User-Facing Behavior

An operator who opens the admin after a quiet weekend sees an active "no live workers" alert stating how long the fleet has been silent, when it was raised, and a link to the workers view. A stalled run raises one alert that stays active until the run recovers or fails, then resolves per lifecycle. Backlog alerts state the measured depth or age against the configured threshold. Acknowledging and resolving behaves exactly like existing alerts.

## Interface Contract

- Alert records for the new conditions flow through the existing alert storage, listing, detail, acknowledge, and resolve contracts unchanged — the alerts UI needs no new API shapes, only new alert kinds/labels.
- Condition definitions and thresholds are shared server-side with admin-tools/007 and admin-tools/008 so the monitoring views and alerts can never disagree about whether a condition holds.

## Acceptance Criteria

- [x] Each of the five conditions raises exactly one active alert while it persists, with the observed value and threshold in its context, and follows the existing lifecycle on clearance and recurrence.
- [x] Fleet-silence alerting demonstrably fires when no worker process is alive.
- [x] Alerts and the monitoring views consume the same server-side condition evaluations, and at each threshold boundary the shared evaluation flips exactly once (views may additionally display raw measures below alert thresholds).
- [x] A fleet-silence alert still raises when no presence records exist at all, reporting the duration as unknown/at-least-the-retention-window rather than fabricating one.
- [x] New alerts render in the existing alerts UI with functioning acknowledge/resolve and navigation context.
- [x] No external delivery channel is introduced; no secrets or raw payloads appear in alert context.

## Verification

Alert-generation tests prove raise/dedupe/resolve/recur for each condition around its threshold (just-under raises nothing; just-over raises once; persistence doesn't duplicate; clearance resolves), including a fleet-silence scenario with no live worker in the composition. The affected package and admin test suites and typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: The five conditions are derived only from the admin-tools/006–008 shared evaluations and published worker settings, and are published through the existing operational-event-to-alert path, so the monitoring views and the alerts cannot disagree.
- Divergences: The queue-depth ceiling was added to the shared `evaluateRecomputationBacklog` rather than applied only in alerting, so the background-work badge and the alert flip at the same depth; a single `machinery_recovered` kind closes all five conditions because each alert's recovery key already names which condition cleared.
- Verification: `npm run lint:admin` (0), `npm run typecheck` (0), `npm run test:services` (0, 386 passing), `npm run test:admin` (0, 159 passing), `npm run test:database` (0, 127 passing), `npm run build:admin` (0), `npm run scan:framework-standards:ratchet` (0, no new findings). Also `npm run lint` (0), `npm run test:contracts` (0, 142 passing), `npm run test:worker` (0, 84 passing), `npm run check:framework` (0).
