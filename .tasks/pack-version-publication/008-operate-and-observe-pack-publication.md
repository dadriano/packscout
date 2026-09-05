# Task: Operate and Observe Pack Publication

**ID:** pack-version-publication/008
**Depends on:** pack-version-publication/006, pack-version-publication/007
**Blocks:** pack-version-publication/010
**Delivery phase:** P08
**Estimated scope:** medium
**Estimated effort:** 1.5–2 days for one builder after dependencies are complete, including timing, alert, authorization, Admin, and fault-drill verification
**Status:** todo

## Requested operator handoff — 2026-09-05

The user explicitly requests Admin/monitoring screenshots and a guide to managing the system. Deliver `docs/pack-catalog-v1-operations.md` with verified routes/commands and an exact-commit screenshot/evidence index. Cover per-pack/profile status and reason interpretation,15-minute health/30-minute alert behavior, delayed/blocked/held/provider-unavailable triage, permissions, normal operating checks, P06 protected preview/apply recovery and gate commands, P09 safe retention, and P10 launch/abort/rollback boundaries. Explain that Admin is read-only and cannot execute publication or alert transitions. Do not present old provider-manifest/Heat runbooks as V1 instructions or document commands before implementation.

Capture actual wide/narrow overview, filtered/paged list, entity detail, delayed alert and unavailable/denied/empty/recovery states against the certified phase build, with keyboard/focus and sanitized organization-scope evidence. Existing signup-review screenshots and design comps are not V1 monitoring proof. P10 adds exact production launch evidence to this guide/index; screenshots alone do not certify timing, isolation or authority receipts.

## Handoff — 2026-09-04

Not started; requires P06 and P07. Status and alerts are per pack/profile, not a provider-wide publication barrier. Admin remains read-only and default-off; do not add retry/hold/publish controls there. Prove pending-time alerts and exact-commit launch readiness through the normal worker paths. This task does not authorize production seeding or launch.

Shared resume instructions: [_handoff.md](_handoff.md). This is a status/context update, not authorization to begin a later phase.

## Start Here

Drive published, waiting, retry-scheduled, blocked, superseded, held, and provider-unavailable fixtures through the normal planner and publisher, advance the oldest pending item beyond 30 minutes, and record the expected status, alert, Admin, and readiness evidence.

## Objective

Give authorized operators a bounded, sanitized view of pack and profile publication health, alert them when pending work exceeds 30 minutes, and produce trustworthy evidence for public launch authorization.

## Context

Publication progresses independently by pack, provider profile, and collectible profile across provider databases, central work, and the public store. Operators need to identify the exact delayed or blocked entity without turning one failure into a global status or exposing protected provider data.

A healthy item is expected to advance from ready to active within 15 minutes. A pending item older than 30 minutes requires a deduplicated alert and visible reason. Operational drills must exercise the same planner and publisher entry points used by normal work so launch evidence proves real behavior.

## Delivery Context

P08 starts after P06 and P07. Its review promise is a read-only operations contract, disabled alert lifecycle, default-off Admin surface, and repeatable launch-readiness drill suite. After merge, Admin navigation, route access, alert evaluation, Admin-alert persistence, and public launch remain disabled. P10 may authorize them only when the exact readiness evidence is complete.

## Requirements

### Bounded publication status

- Report entity kind, organization, provider, stable pack or profile identity, the P01 work state and reason code, desired sequence, desired and active snapshot or profile identities, hold state, attempt count, next retry, `readyAt`, age, and last success.
- Compose provider-local, central-profile, and public-store evidence without exposing raw payloads or treating an unavailable provider as a global failure.
- Provide bounded organization and provider summaries plus cursor-bounded entity pages ordered by severity, age, and stable identity.
- Measure the healthy ready-to-active target from the instant complete valid work first becomes claimable; exclude an explicit operator hold while keeping it visible.
- Demonstrate that healthy ready work becomes active within 15 minutes under the declared operating envelope.

### Oldest-pending alert

- Evaluate the oldest non-terminal unheld work for each authorized organization and provider boundary.
- Open an alert only when its pending age is greater than 30 minutes, with exact clock evidence and a stable sanitized reason.
- Deduplicate repeated evaluations into one open alert, update its oldest affected evidence, and resolve it only after no qualifying work remains.
- Persist alerts only through the existing durable Admin notification boundary, bound alert history, affected-entity samples, reason text, and persistence attempts, and define success as a durable Admin-alert upsert.
- Let only the trusted scheduled alert evaluator open, update, and automatically resolve publication alerts; Admin users can only view them, and evaluation/persistence ships disabled until P10 authorization with no email, webhook, push, or other external delivery.

### Read-only Admin

- Keep navigation, route registration, server composition, and data access default-off until P10 authorization.
- Require `providers:view` and organization scope for every request, grant that read to both active `admin` and `data_operator` roles, and refuse cross-organization, missing-permission, disabled-account, expired-session, and direct-route access.
- Present summary, entity table, detail, oldest-pending alert, loading, empty, unavailable, denied, and recovery states at narrow and wide viewports.
- Sanitize records before they reach the browser and omit credentials, database locations, request bodies, source evidence, stack traces, and unbounded reason data.
- Expose no retry, hold, rollback, resume, delete, alert-action, schedule, credential, or launch control; publication-control mutation remains exclusively in P06 protected commands, and only the trusted evaluator may transition alert records.

### Launch readiness and drills

- Derive the initial inventory from every enabled provider configuration and every declared provider, profile, and pack at one input cutoff; classify ready entities as included and waiting, blocked, or unreachable entities as excluded with a reason, close each included pack over its required included profiles, omit none, and require at least one included pack overall.
- Exercise provider unavailable, poison pack, missing initial profile, partial staging, lost response, lease loss, activation conflict, hold, expired authorization, and delayed-work cases through the normal planner and publisher.
- Prove each failure affects only its entity while independent healthy packs and profiles continue to active state.
- Exercise all six P07 journeys against the resulting active heads, including saves, lifecycle visibility, action eligibility, and cursor recovery.
- Produce `PackCatalogLaunchPlanV1` as `approved_to_seed` only when inventory, dependency closure, integrity, timing, isolation, authorization, UI, alert, and fault-drill criteria pass; also provide a post-seed evaluator that emits `PackCatalogLaunchReadinessV1.ready` only when the complete reachable production-head set equals that plan's included profiles and packs, every head and smoke check matches, and no excluded or undeclared entity is reachable.

## User-Facing Behavior

Buyer-facing catalog behavior does not change when this task merges. Once authorized, operators can view which individual pack or profile is active, delayed, blocked, held, or unavailable and see a sanitized reason. The Admin experience remains strictly read-only.

## Interface Contract

`PackPublicationStatusV1` represents one pack or profile with stable scope, desired and active evidence, the exact P01 work state and reason code, timing, hold, retry, and sanitized fields. `PackPublicationOverviewV1` provides bounded counts, oldest ages, provider summaries, and page metadata.

`PackPublicationStatusQueries` exposes `getPackPublicationOverview({ organizationId, providerId? })`, `listPackPublicationStatuses({ organizationId, providerId?, entityKind?, workState?, reasonCode?, held?, pageSize, cursor? })`, and `getPackPublicationStatus({ organizationId, entityKind, stableEntityId })`. Every call derives the actor from the session, requires `providers:view`, enforces organization scope, and returns bounded `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_QUERY`, `CURSOR_EXPIRED`, or `STATUS_UNAVAILABLE` errors.

`PackPublicationStatusCursor` is opaque, signed, and bound to organization, optional provider, filters, severity-descending/age-descending/stable-identity-ascending order, page size, last ordering tuple, issue time, and expiry. It is valid only for `listPackPublicationStatuses` with the query shape that issued it.

`PackPublicationAlertV1` records alert identity, organization/provider scope, threshold, first and latest qualifying times, oldest pending evidence, bounded affected samples, Admin-persistence state, and resolution evidence. It has no external destination.

`PackPublicationAlertEvaluator.evaluateOldestPending` is a trusted scheduled operation, not an Admin or public mutation. It alone creates, updates, and resolves the publication-alert record for an organization/provider key and returns the durable upsert receipt used as success evidence.

`PackCatalogLaunchPlanV1` binds its canonical digest to the exact commit, configuration digest, input cutoff, full inventory digest, every included and excluded identity with reason, included profile-dependency closure, canonical six-journey fixtures, timing, isolation, security, Admin, alert, and fault-drill evidence plus `approved_to_seed` or `blocked`.

`PackCatalogLaunchReadinessV1` binds the exact launch-plan digest to the complete reachable production-head-set digest, included-head coverage and hashes, proof that excluded and undeclared identities have no head, query smoke results, and `ready` or `blocked`. Neither artifact grants mutation authority; P06 protected commands remain the only operator mutation boundary.

## Acceptance Criteria

### Launch inventory

- [ ] Every entity declared by an enabled provider configuration at the cutoff appears exactly once as included or excluded with a stable reason.
- [ ] Every ready entity is included, every included pack closes over its required included profiles, and at least one pack is included.
- [ ] Waiting, blocked, unreachable, or omitted entities cannot be silently treated as launch-ready or prevent independent included packs from qualifying, and none has a reachable head in a `ready` result.

### Status, timing, and alerts

- [ ] Status and overview results are bounded, organization-scoped, entity-specific, and consistent with provider, central, and public-store receipts.
- [ ] Healthy complete work reaches active state within 15 minutes under the declared operating envelope.
- [ ] Pending age at exactly 30 minutes does not alert; age greater than 30 minutes opens one deduplicated alert.
- [ ] Repeated evaluation updates rather than duplicates the alert, and recovery resolves it only when no qualifying work remains.
- [ ] One unavailable provider or poison entity does not distort independent status or prevent healthy publication.

### Admin, security, and readiness

- [ ] Admin navigation, route, server composition, data fetch, alert processing, and persistence remain disabled after merge.
- [ ] Active admins and data operators holding `providers:view` see only sanitized records for their organization; direct, cross-organization, missing-permission, disabled-account, and expired access fail closed.
- [ ] Admin remains read-only and cannot reach any P06 command or acknowledge, resolve, or otherwise mutate a publication alert; only the trusted evaluator transitions alerts.
- [ ] Fault drills use the normal planner and publisher and prove entity isolation across every named failure.
- [ ] P10 receives `approved_to_seed` only from a complete plan and receives a digest-bound post-seed `ready` record only when every included head matches, the full reachable-head set contains no excluded or undeclared identity, and every launch criterion passes; incomplete, extra, or conflicting evidence returns `blocked`.

### Status query contract

- [ ] The verified V1 operations guide and commit-bound Admin/monitoring screenshots cover normal checks, alerts, protected recovery, retention and launch boundaries without invented commands or browser mutation controls.

- [ ] Overview, list, and detail calls use the exact named inputs, require `providers:view`, enforce organization scope, and return only bounded DTOs or declared errors.
- [ ] Status pagination follows the declared severity, age, and stable-identity order, and a cursor fails with `CURSOR_EXPIRED` after expiry, tampering, or any bound query change.

## Verification

Named scenario: **Publication operations and launch-readiness drill** — run normal work through healthy timing, a 30-minute threshold boundary, every named fault, scoped Admin access, alert deduplication/resolution, and all six catalog journeys, then require one complete readiness result.
