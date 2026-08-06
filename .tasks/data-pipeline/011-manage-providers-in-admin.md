# Task: Manage Providers in the Admin

**ID:** data-pipeline/011  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/001](001-protect-data-operations.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md)  
**Blocks:** [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** todo

## Objective

Administrators can manage the complete provider lifecycle from the PackScout admin, while data operators can inspect masked configuration and current provider health without gaining mutation or secret access.

## Context

The admin already provides responsive navigation, shared page headers, dialogs, confirmations, toasts, status badges, and empty states. This feature must extend those patterns rather than create a separate visual system. Browser requests go through admin API helpers and never import server, adapter, database, scheduler, or secret-bearing code.

A provider configuration contains platform, adapter, endpoint, authentication mode, bearer-secret presence, schedule, stale threshold, lifecycle state, version, connection-test result, and health. There is one enabled configuration per platform. Changes create revisions; there is no hard delete.

## Requirements

### Configuration workflow

- Add a provider-management destination within the existing admin shell with a compact list of platform, adapter, lifecycle state, masked authentication state, schedule, stale threshold, freshness, quality, active run, latest test, and latest run.
- Provide administrator flows to create a draft, edit by creating a revision, set or rotate a bearer token, run a connection test, enable, disable, and archive.
- Require platform, adapter, endpoint, authentication mode, schedule, and stale threshold inputs; show adapter and endpoint validation at the field; show bearer-secret presence without ever reading the stored token back.
- Preserve an existing bearer token when its edit field is left untouched. Make an explicit administrator action remove or replace it, with consequences shown before saving.
- Keep enablement unavailable until the current revision has a successful connection test. Present pending, success, authentication failure, timeout, unreachable, HTTP failure, invalid JSON, contract failure, and stale-test outcomes.

### Lifecycle, permissions, and states

- Warn and require confirmation before disablement or archival, explaining that no new runs start and an active run finishes. Do not present a hard-delete action.
- Detect optimistic revision conflicts, preserve unsaved administrator input, and offer a clear reload path instead of overwriting a newer revision.
- Allow data operators to view the list, detail, masked settings, connection-test summary, and health; hide or disable configuration, secret, enablement, disablement, and archival actions while enforcing the same restriction server-side.
- Cover loading, empty, no-match, validation, forbidden, failure, success, dirty, confirmation, and narrow-screen states with keyboard, focus, labelling, contrast, and live feedback.

## User-Facing Behavior

An administrator opens Data Providers, creates a draft, selects a registered adapter and platform, enters endpoint and timing settings, chooses no authentication or bearer authentication, saves, tests the connection, and enables the tested revision. Editing produces a new visible version. Disable and archive actions explain their impact and preserve history.

A data operator sees the same operational identity and health but cannot reveal or change credentials or lifecycle. A secret is always represented as configured or missing, never as token text.

## Interface Contract

The browser API uses the masked configuration, connection-test, lifecycle, and health contracts from tasks 004 and 010. Mutation requests carry the current revision identity. Secret writes send a new token only when an administrator explicitly changes it; response bodies contain `has_bearer_secret` and no secret value.

Connection tests return fixed verdicts and bounded evidence. Lifecycle actions return the new configuration revision and scheduling state. Stable API errors map to field errors, access-restricted states, revision conflict, or non-destructive failure feedback.

## Acceptance Criteria

- [ ] An administrator can create, revise, test, enable, disable, and archive a provider through the admin while history and one-active-per-platform rules remain visible and enforced.
- [ ] Bearer tokens never appear in reads, DOM state after save, errors, logs, toasts, or browser bundles; untouched secret fields preserve the stored credential.
- [ ] Data operators can inspect provider health but cannot mutate configurations, secrets, or lifecycle through UI controls or direct requests.
- [ ] Connection-test verdicts, enablement gating, revision conflicts, active-run consequences, loading, empty, error, success, and dirty states are complete and accessible.
- [ ] Responsive browser smoke checks prove the workflow at desktop and mobile widths without page-level overflow or inaccessible dialogs.
