# Task: Monitor the Worker Fleet in the Admin

**ID:** admin-tools/007
**Depends on:** admin-tools/006
**Blocks:** admin-tools/009
**Estimated scope:** large
**Status:** todo

## Objective

Operators can open a worker-monitoring view in the admin and answer, at a glance: are workers alive, what is each one doing, is any run stalled, is any provider's schedule overdue or stuck, and what operating settings is the pipeline actually running with.

## Context

The admin already shows the results of pipeline work — provider freshness/quality, import-run history, quarantine, and operational alerts — but nothing about the machinery producing those results. The worker fleet (admin-tools/006 presence records), schedule claims, and run heartbeats together describe that machinery, and all of it is already durable data the admin server can read.

This view completes the pipeline-operations story: providers answer "is the data healthy?", runs answer "what happened?", and this view answers "is the machine running?". It also closes a configuration-visibility gap: per-provider schedule cadence and data-staleness settings are already configured and shown on the admin's provider pages, but the worker-runtime settings (heartbeat cadence, lease and heartbeat staleness thresholds, retention windows) are set outside the admin, so operators currently cannot see the effective values their observations should be judged against. admin-tools/006 makes the worker publish those effective settings; this view reads them.

Both operator roles may view it — it is operational status, like the existing operations and runs pages, with no secrets involved.

## Requirements

- Add a worker-monitoring destination in the admin's pipeline navigation, viewable by both `admin` and `data_operator` under the existing view-oriented pipeline permission, and guarded server-side the same way as existing operations pages.
- Fleet overview: each recent worker instance with its state (running, stopped, or stale/presumed-dead derived from heartbeat age against the admin-tools/006 threshold), version, start time, last-heartbeat time and age, and current activity, distinguishing a healthy idle fleet from an absent one.
- An explicit fleet-level statement when no live worker exists ("no worker has heartbeated for N minutes") — this is the page's most important state, since silent fleet death is otherwise invisible. When no presence record exists at all (fresh deployment, or every record pruned past the retention window), the page states that no worker has ever reported within the retained window rather than fabricating a duration.
- Stalled-run surfacing: import runs in a running state whose heartbeat age exceeds the run-heartbeat staleness threshold published by admin-tools/006 are listed with their provider, owning instance, run identity, and heartbeat age, linking to the existing run detail view.
- Schedule health: per provider, the next-due time, overdue amount when past due, and any claim held past its expiry, so a wedged schedule is visible; link to the provider's existing detail view.
- Effective worker operating settings displayed read-only — heartbeat cadence, presence and run-heartbeat staleness thresholds, lease durations, and retention windows — sourced from the effective-settings surface the worker publishes (admin-tools/006), never hard-coded copies, and containing no secrets. Per-provider schedule cadence stays on the existing provider pages and is not duplicated here beyond the schedule-health rows.
- Bounded, paginated queries throughout; loading, empty, degraded (some data unavailable), error, and forbidden states covered accessibly; responsive at desktop and narrow widths; reuse existing admin shell, ledger, status-badge, and pagination patterns.
- Status freshens without manual page reloads at a bounded polling cadence consistent with the admin's existing live-status behavior; no unbounded or per-second polling.

## User-Facing Behavior

An operator opens Workers and immediately sees a headline fleet state: healthy (live workers, none stale), degraded (a stale instance or stalled run), or dead (no live workers), with the evidence beneath — the instance list, stalled runs, and overdue schedules. Each problem row links to the existing page that acts on it (run detail, provider detail). A settings panel states the cadences and thresholds in force so operators can interpret what "overdue" and "stale" mean. Data operators see everything; nothing here mutates state.

## Interface Contract

- The admin exposes protected read endpoints for: worker instances (from admin-tools/006 records with derived staleness), stalled runs (running + heartbeat age past threshold), schedule health (next-due/overdue/claim-expiry per provider), and effective operating settings — paginated where lists can grow, following the admin's existing pagination and error conventions.
- Rows carry the identities needed to deep-link into existing run and provider views.
- admin-tools/009 reuses the same derived conditions (fleet silent, stalled run, overdue schedule) as its alert triggers, so the definitions must live server-side where both consumers share them, not in the browser.

## Acceptance Criteria

- [ ] With live workers, the view shows each instance's state, activity, version, and heartbeat age; with none, it states fleet silence explicitly with the silence duration — or the never-reported statement when no presence records exist at all.
- [ ] A run whose heartbeat exceeds the threshold appears as stalled, attributed to its owning instance, linking to run detail.
- [ ] A provider past its next-due time (or with an expired claim) appears in schedule health with the overdue amount, linking to provider detail.
- [ ] Displayed operating settings match the values the worker published (admin-tools/006), not hard-coded admin-side copies.
- [ ] Anonymous requests get the standard unauthenticated error; both operator roles can view; all listed states render accessibly without page-level overflow at narrow widths.

## Verification

Admin route behavior tests prove the authorization matrix, staleness/overdue derivations at their thresholds (just-under vs just-over), fleet-silence reporting, and pagination bounds; a page-level test covers healthy, degraded, dead-fleet, and forbidden renderings. The admin lint, typecheck, test, and build commands exit 0.
