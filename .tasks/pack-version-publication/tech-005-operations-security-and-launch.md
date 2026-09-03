# Technical Spec: Operations, Security, and Launch

**ID:** pack-version-publication/tech-005
**Related tasks:** pack-version-publication/006, pack-version-publication/008, pack-version-publication/009, pack-version-publication/010
**Depends on technical specs:** pack-version-publication/tech-001, pack-version-publication/tech-002, pack-version-publication/tech-003, pack-version-publication/tech-004
**Spec status:** draft

## Purpose

Provide read-only per-entity operations, durable delay alerts, exact launch evidence, and an invisible infrastructure launch that enables recurring per-pack publication only after the sole V1 application is certified.

## Current System Context

### Confirmed repository facts

- `packages/contracts/src/auth.ts` defines `admin` and `data_operator` permissions; both roles currently receive `providers:view` through `packages/services/src/auth-service.ts`.
- Admin HTTP composition in `apps/admin/server/app.ts` registers dependencies explicitly, and `apps/admin/src/App.tsx` plus `AdminLayout.tsx` register routes/navigation statically.
- Existing operational health and alert routes require authenticated organization-scoped access; the alert route currently exposes acknowledge and resolve mutations.
- `PrismaAdminNotificationPublisher` stores deduplicated `operational_events` and `admin_alerts`, including system-driven recovery resolution.
- No pack-publication status projection, launch-plan/readiness record, worker-gate command authority, or deployment-route driver exists on the checked-out branch.

### Confirmed task constraints

- Status is per pack, provider profile, or collectible profile; an unavailable provider is not a platform-wide failure.
- Active admins and data operators may view sanitized status through `providers:view`; only admins can hold the three new command permissions.
- Publication alerts persist only in the existing Admin alerts area and can be transitioned only by the trusted evaluator.
- Admin navigation, routes, data access, alert evaluation, and persistence are default-off until P10 authorization.
- Launch uses an atomic infrastructure blue/green route, allows ingestion to pause, exposes no maintenance interval, and removes the pre-launch route target before recurring V1 writes begin.

## Proposed Implementation

### Authorization model

Extend `OperatorPermission` with `pack_publication:recover`, `pack_catalog:launch`, and `pack_catalog:prune`. Add all three only to `ADMIN_PERMISSIONS`; retain `providers:view` for both active roles. Every service rechecks current account state, organization membership, permission, environment, scope digest, expiry, and idempotency rather than trusting UI state.

Protected commands use two independent authorities:

1. A short-lived Ed25519 command attestation binds an active admin, required permission, environment, exact operation, scope digest, preview/plan digest, issue time, and expiry.
2. A trusted deployment identity signs the execution request and is verified separately from the operator.
3. A central one-time authorization row binds both identities and the canonical request digest before work begins.
4. Exact replay returns the recorded receipt; changed scope, expired authority, disabled actor, or different request is refused.
5. Private signing keys remain in release automation; workers and application servers receive verification keys only.

Selectively rewrite the short-lived command-attestation verification mechanics from PR 66. Do not carry its authorities or job names. Recovery, launch, and prune use separate scope schemas and cannot authorize one another.

### Central status projection

Do not fan out to every provider database during an Admin list request. Each provider transaction that changes pack publication state writes a sanitized `pack_publication_status_outbox` event. A fair relay projects it into the central `pack_publication_status_projections` table using entity identity plus monotonic local sequence/fence.

Central profile transitions write the same read-model shape directly in their central transaction. Verified Convex receipts supply public snapshot/head evidence. Provider reachability and projection observation time are joined at read time so stale or unreachable state is explicit.

The status projection is not publication authority. P06 recovery still reconciles provider and Convex source records; P08 launch readiness directly verifies full provider inventories and Convex heads rather than trusting the Admin projection alone.

`PackPublicationStatusService` serves overview, list, and detail from the bounded central read model. It applies organization scope from the authenticated session, signs status cursors with the server key, and returns no raw payload, database location, request body, credential, stack trace, or unbounded text.

### Read-only Admin surface

Add `PACKSCOUT_PACK_PUBLICATION_ADMIN_ENABLED=1` as the sole runtime route/composition authority. Absence or any other value is false. The authenticated session response exposes only the resulting boolean feature state, which the client uses to register the page and navigation; the server independently omits the API router while false.

The `/pack-publication` page contains:

- Overview counts, oldest pending age, healthy timing, and provider-scoped summaries.
- Cursor-paged entity table with kind, stable identity, state, reason, age, hold, retry, desired evidence, and active evidence.
- Read-only entity detail with sanitized transition/receipt identities and observation times.
- Loading, empty, unavailable, denied, stale-provider, and cursor-recovery states.
- Responsive semantic table/cards, keyboard focus, visible focus, accessible names, and live status messages.

There are no retry, hold, rollback, resume, delete, alert, schedule, credential, seed, launch, or prune controls. The Admin API exposes GET routes only.

### Existing alert boundary

Extend operational notification contracts with `pack_publication_delayed` and `pack_publication_recovered`. Add a transition policy to alerts; publication alerts use `evaluator_only`, while existing alert behavior remains explicit for its own kinds.

`OperationalAlertService.acknowledge` and `.resolve` refuse an `evaluator_only` alert even if called directly. The Admin UI receives `allowedActions: []` and renders no action control. `PackPublicationAlertEvaluator` writes through a dedicated trusted repository method, not the operator route.

For each organization/provider or central-profile boundary, the evaluator:

1. Selects the oldest unheld `waiting`, `ready`, `publishing`, or `retry_scheduled` entity using database time.
2. Opens no alert at age equal to 30 minutes and opens one only when age is greater than 30 minutes.
3. Upserts one stable dedupe key with threshold evidence, oldest entity, bounded samples, reason, first/latest qualifying time, and persistence receipt.
4. Updates the same alert while qualifying work remains.
5. Resolves it only when no qualifying work remains; explicit holds stay visible but do not age or alert.

Schedule evaluation at a bounded one-minute cadence but keep both the schedule and publication-event persistence disabled until P10. No email, webhook, push, or external notifier consumes these events.

### Healthy timing and status ordering

Set `readyAt` once, when complete valid work first becomes claimable. The 15-minute health target measures `readyAt` to active-head receipt. Waiting time remains visible separately and may trigger the 30-minute pending alert.

Status list order is severity descending, pending age descending, then stable entity identity ascending. The signed cursor binds organization, optional provider, all filters, page size, last ordering tuple, issue time, and expiry. It returns `CURSOR_EXPIRED` for any tampering, expiry, or bound-query change.

### Launch-plan and readiness evaluators

`PackCatalogLaunchPlanEvaluator` runs out of band before seeding. It freezes one cutoff and builds a complete inventory from enabled provider configurations, durable provider inventory snapshots, central profiles, and current Convex heads.

Each declared profile/pack appears exactly once as included or excluded with a stable reason. Ready entities are included; waiting, blocked, or unreachable entities are excluded and must have no reachable head. Included packs close over their provider and collectible profile dependencies. At least one pack is required.

The plan also binds exact application commit, configuration digest, inventory digest, retention policy digest, P01 contract/fixture digest, six-journey evidence, timing evidence, authorization checks, alert checks, and named fault-drill receipts. Only complete evidence produces `approved_to_seed`; all other results are `blocked` with bounded reasons.

After P10 seed work drains, `PackCatalogLaunchReadinessEvaluator` queries every included provider record and a private bounded Convex head-inventory endpoint. It requires exact included head identity/hash coverage, no head for excluded or undeclared identities, no unresolved operation, and successful six-journey smoke evidence before returning `ready` bound to the launch-plan digest.

### Fault drills

Run drills through the normal planner, assembler, publisher, status, and query entry points. The required matrix covers these groups:

- Provider unavailable, poison pack, missing initial profile, and partial staging.
- Lost response, receipt reconciliation, lease loss, and activation conflict.
- Hold, retained activation, resume, and expired authorization.
- Delayed work at 30 minutes exactly and just beyond 30 minutes.
- All six catalog journeys, saves, lifecycle/action rules, and cursor recovery.

Each drill proves the named entity fails or pauses while at least one unrelated pack advances and public reads remain available.

### P10 infrastructure launch

P10 runs an environment-specific release command against the exact merged commit. Application code contains no route selector and cannot call the pre-launch artifact.

Preparation and seed:

1. Record commit, configuration, cutoff, disabled gate generation, approved plan, retention policy, active launch admin, deployment identity, and routing authority.
2. Pause ingestion if needed, keep recurring claims disabled, and verify each provider schema/reachability independently.
3. Invoke `seed-pack-catalog` once with the exact included/excluded inventory; profiles publish before dependent packs through the normal P04/P06 flow.
4. Drain that fixed seed to the cutoff and obtain digest-bound `PackCatalogLaunchReadinessV1.ready`.
5. Abort without routing changes if any prerequisite or outcome is missing, conflicting, expired, or unknown.

Route and certify:

1. Atomically route buyers to the exact certified V1 application through the deployment platform.
2. Run all six journeys, saves, direct links, full contents, lifecycle/action, odds, chase, valuation, and EV smoke checks while recurring writers remain disabled.
3. On failed smoke, restore the pre-launch route while writers remain disabled and do not change pack heads.
4. On green smoke, declare V1 authoritative and remove the pre-launch artifact from the route rollback slot before enabling recurring workers, status/alerts, and ingestion.
5. Observe two independent pipeline updates, prove only their respective pack heads advance, seal a successful ledger, and issue bounded pruning authorization.

After that removal, application recovery uses only the last certified V1 artifact. An aborted or unknown launch issues no pruning authorization and leaves recurring work disabled until reconciled.

## Code Changes

### Contracts, services, and database

1. Extend auth/status/alert/readiness/launch contracts in the tech-001 modules and add the three permissions to `auth.ts` plus role grants in `auth-service.ts`.
2. Add provider status outbox persistence, central status projection/inventory/readiness repositories, and signed cursor helpers under `packages/database/src`.
3. Add status, alert evaluator, command authority, launch-plan, launch-readiness, and ledger services under `packages/services/src`.
4. Add a private Convex complete-head-inventory query and client; validate bounds and exact head/snapshot hashes.
5. Add environment-scoped drill, authorization, gate, seed, readiness, launch, abort, and prune commands under the appropriate `scripts/*` directories.

### Admin

1. Add `apps/admin/server/routes/pack-publication.ts` with GET-only overview/list/detail routes and compose it only when the server gate is enabled.
2. Add `apps/admin/src/api/pack-publication.ts`, hooks, page, table/detail components, route, styles, and navigation behind the compiled client gate.
3. Extend existing alert contracts/repository/service/UI with `evaluator_only` and refuse operator transitions at service and persistence boundaries.
4. Add fail-closed runtime-config parsing, authenticated feature-state reporting, configuration-digest reporting, and route behavior tests.
5. Keep every protected command client and credential out of `apps/admin`, frontend packages, and browser-safe exports.

## Database / Schema Changes

### Provider and central status data

| Table | Purpose |
|---|---|
| Provider `pack_publication_status_outbox` | Transactional sanitized status transition awaiting central relay |
| Central `pack_publication_status_projections` | Latest per-entity status, source sequence, public evidence, and observation time |
| Central `pack_publication_provider_summaries` | Bounded reachability and inventory-digest evidence per provider |
| Central `pack_publication_alert_evaluations` | Evaluator checkpoint, threshold evidence, and durable upsert receipt |
| Central `pack_catalog_worker_gates` / receipts | Environment generation, state, cutoff/configuration digest, and family drain/enable evidence |

Status rows are unique by organization, entity kind, and stable entity ID. Projection updates require a greater source sequence or exact replay digest; provider sequences are never compared across providers.

### Authorization and launch data

| Table | Purpose |
|---|---|
| `pack_catalog_command_authorizations` | Short-lived actor/deployment scope and one-time canonical request binding |
| `pack_catalog_launch_plans` | Immutable pre-seed inventory, dependency closure, evidence, status, and digest |
| `pack_catalog_launch_readiness` | Immutable post-seed full-head coverage, smoke evidence, status, and digest |
| `pack_catalog_launch_ledgers` | Route/gate/smoke/first-publication receipts and `succeeded` or `aborted` outcome |
| `pack_catalog_pruning_authorizations` | Successful-ledger policy digest, expiry, group cap, and byte cap |

Extend `admin_alerts` with `transition_policy` and publication scope/evidence fields, or store those bounded fields in an exact validated JSON column if the existing schema convention requires it. Add unique dedupe/recovery keys for each organization/provider-or-central boundary.

## Interfaces, APIs, and Endpoints

`PackPublicationStatusV1` is the bounded per-pack/profile DTO containing organization, provider, entity kind, stable identity, desired sequence/snapshot evidence, active snapshot/head evidence, shared work state/reason, hold, attempts, next retry, `readyAt`, pending age, last success, and observation time. `PackPublicationOverviewV1` contains bounded counts, oldest ages, provider summaries, and page metadata.

`PackPublicationStatusCursor` is the opaque signed status cursor described above. `PackPublicationAlertV1` contains the stable alert/scope identity, threshold and oldest evidence, bounded affected samples, persistence state, and evaluator-owned resolution evidence; it has no external destination.

`PackPublicationStatusQueries` exposes exactly:

```ts
getPackPublicationOverview({ organizationId, providerId? })
listPackPublicationStatuses({ organizationId, providerId?, entityKind?, workState?, reasonCode?, held?, pageSize, cursor? })
getPackPublicationStatus({ organizationId, entityKind, stableEntityId })
```

The Admin server maps them to `GET /api/pack-publication/overview`, `GET /api/pack-publication/statuses`, and `GET /api/pack-publication/statuses/:entityKind/:stableEntityId`. It constructs `organizationId` from the session and refuses a conflicting client-supplied value.

Status returns only `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_QUERY`, `CURSOR_EXPIRED`, or `STATUS_UNAVAILABLE` on failure.

`PackPublicationAlertEvaluator.evaluateOldestPending({ organizationId, providerId? })` is a trusted scheduled service operation and returns the durable Admin-alert upsert/resolve receipt. There is no Admin endpoint for it.

`PackCatalogLaunchPlanV1`, `PackCatalogLaunchReadinessV1`, and `PackCatalogV1LaunchLedger` use immutable canonical digests. The ledger binds exact commit/configuration/cutoff, plan/readiness/inventory/retention/head-set digests, actor and deployment authority, route receipt, smoke results, prior/resulting gate generations, first two independent pack publications, and terminal outcome.

Only `succeeded` or `aborted` is terminal. Only `succeeded` may create a bounded `pruningAuthorizationId`; `aborted` creates none, and partial/unknown evidence keeps writers and pruning disabled.

## Data Flow

### Status projection

1. A pack/profile transition commits with a sanitized status event or central projection.
2. The provider relay forwards outbox events fairly and retries by event identity.
3. Central projection accepts a greater entity-local sequence or exact replay.
4. Admin GET services apply session scope and return bounded signed pages.
5. Missing provider contact adds stale/unavailable evidence without rewriting another entity's state.

### Alert evaluation

1. The disabled-by-default scheduler invokes the evaluator for one organization/provider boundary.
2. The evaluator computes oldest qualifying age from database time and excludes held work.
3. Age greater than 30 minutes upserts one delayed event/alert; no qualifying work writes its recovery event.
4. The existing notification transaction deduplicates or resolves and records its receipt.
5. Only durable alert persistence counts as evaluator success.

### Launch evidence

1. Pre-seed evaluation freezes exact commit/configuration/cutoff/inventory and produces `approved_to_seed` or `blocked`.
2. P10 seeds that exact inventory through normal publication with recurring claims disabled.
3. Post-seed evaluation compares the full reachable Convex head set with the plan and runs query smoke checks.
4. Infrastructure routing and smoke results are appended to the immutable ledger flow.
5. Two independent post-resume pack receipts complete a successful ledger and bounded pruning authority.

## Error Handling and Edge Cases

- A delayed or unreachable provider marks only its status rows stale/unavailable; overview still reports healthy providers and never fabricates current provider state.
- Cross-organization, disabled-session, missing-permission, feature-disabled, cursor-mismatch, and direct-route requests fail before repository access.
- Operator attempts to acknowledge/resolve publication alerts return `FORBIDDEN`; evaluator retries exact persistence without duplicating an alert.
- Any extra, excluded, undeclared, incomplete, hash-mismatched, or unresolved public head makes launch readiness `blocked`.
- An unknown infrastructure route result, smoke result, or gate receipt keeps writers/pruning disabled until the exact operation is reconciled.

## Testing and Verification

1. Unit/integration test status ordering, cursor signing, projection replay, provider staleness, organization scope, both viewer roles, all forbidden actors, and sanitization.
2. Test 30-minute equality/no-alert, greater-than threshold/open, repeated update, recovery/resolve, evaluator-only mutation refusal, and disabled schedule/persistence.
3. Run Admin server/client tests for both feature-gate values, direct route, GET-only API, responsive states, keyboard/focus behavior, and zero control surfaces.
4. Execute every named fault drill and require an unrelated pack to publish plus all active reads to remain available.
5. Rehearse the full launch/abort paths in preproduction, verify exact ledgers and pruning authority, then run `npm run verify:framework` before P08 and P10 handoff.

The named scenarios are **Publication operations and launch-readiness drill** and **First Pack Catalog V1 launch**.

## Open Questions and Risks

- The deployment platform's exact atomic route command and receipt schema are environment-specific and not represented in the repository. P08 must bind a concrete driver and rehearsal evidence before a plan can be `approved_to_seed`; P10 cannot substitute an ad hoc manual step.
- Central status is a projection and can lag. Admin exposes observation time/staleness, while readiness and recovery verify authoritative provider/Convex state directly.
- Enabling runtime Admin visibility and the alert schedule requires separate recorded receipts after green buyer smoke. A missing or unknown process-restart/schedule result leaves both disabled until reconciled.
- Existing alert mutations are generic. Publication alert immutability must be enforced in service and repository code, not only by hiding buttons.

## Handoff Notes

P08 lands status, read-only Admin, alert policy, drills, launch-plan evaluation, and post-seed readiness with every gate off. P10 authors no code; it consumes the exact P08/P09 artifacts and records one terminal ledger.

The final launch proof is two ordinary pipeline updates after resume: each must create its own provider-local request and advance only its own Convex pack head while all unrelated pack bytes and heads remain unchanged.
