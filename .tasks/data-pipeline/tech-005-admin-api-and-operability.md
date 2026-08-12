# Technical Spec: Admin API and Operability

**Spec ID:** tech-005  
**Related tasks:** [data-pipeline/001](001-protect-data-operations.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/006](006-quarantine-and-retry-invalid-records.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/011](011-manage-providers-in-admin.md), [data-pipeline/012](012-operate-imports-in-admin.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md)  
**Depends on tech specs:** [tech-001](tech-001-runtime-security-and-service-boundaries.md), [tech-002](tech-002-provider-feed-storage-and-history.md), [tech-003](tech-003-ingestion-orchestration-and-reliability.md), [tech-004](tech-004-canonical-projections-and-estimated-ev.md)  
**Spec status:** draft

## Purpose

Define the authenticated Express API and admin-client integration needed to configure providers, observe feed health, start imports, recover quarantined records, inspect alerts, and manage operators without exposing secrets or raw provider data.

## Current System Context

- `apps/admin/server/app.ts` owns a small Express API with a one-megabyte JSON limit and stable `{ error, code }` failures.
- `apps/admin/src/api/client.ts` already uses same-origin JSON requests and included credentials.
- The React Router application has only the overview route; the shell, dialog, confirmation, status badge, empty state, toast, and responsive layout primitives already exist.
- The admin top bar and overview explicitly say authentication, persistence, and access controls are not configured.
- Public frontend data views are outside this feature and remain independent.

## Proposed Implementation

### Route organization

Add narrow Express routers under `apps/admin/server/routes` for auth, operators, providers, import runs, quarantine, alerts, and operations. Each route validates path, query, and body input before calling a transport-neutral service.

Routers receive services through `createAdminApp` dependencies so tests can exercise middleware, validation, authorization, response mapping, and external-write boundaries without network or production persistence.

### Read patterns

Use keyset pagination with bounded `limit` values for runs, quarantine, alerts, revisions, and audit history. Filters use allowlisted enums and timestamps. List responses include `items` and `nextCursor`; detail endpoints return related summaries but never raw payload JSON.

Use conditional request versions or explicit `revision` fields for provider edits. A stale client receives `409 CONFIG_REVISION_CONFLICT` with the current safe summary.

### Mutations

Provider save creates a new draft revision. Connection test is a dedicated external action; activation requires a successful test for that exact revision. Disabling a provider, retrying quarantine, acknowledging alerts, and requesting a manual run use explicit service commands and audit outcomes.

Operator and provider state changes are idempotent when the requested target state already applies. Manual-run deduplication returns the active run with a flag.

### Diagnostic safety

Expose normalized error codes, timestamps, counts, endpoint origin/hostname, HTTP status class, adapter key, and request ID where useful. Never return credential values, authorization headers, cookies, raw pages, full upstream response bodies, direct actor identifiers, stack traces, or unrestricted audit metadata.

## Code Changes

### Admin server

- Add shared route validation and response helpers without creating a generic framework inside the app.
- Add session, CSRF, role, organization, rate-limit, and request-ID middleware from [tech-001](tech-001-runtime-security-and-service-boundaries.md).
- Mount protected routers before the existing `/api` not-found handler and keep `/api/health` shallow.
- Add direct behavior tests beside every security-sensitive or external-write route.

### Admin client

- Add typed API modules for session, operators, providers, runs, quarantine, alerts, and operational health.
- Extend `AdminApiError` with optional sanitized details and request ID while preserving status/code behavior.
- Add route-level loading hooks with abort handling and mutation state that disables duplicate submission.
- Keep server-only schemas and implementations out of the Vite dependency graph.

## Database / Schema Changes

No new source-of-truth tables are introduced beyond [tech-001](tech-001-runtime-security-and-service-boundaries.md) through [tech-004](tech-004-canonical-projections-and-estimated-ev.md).

Add supporting indexes only after query shapes are exercised:

- Provider list by `(organization_id, state, platform_key)`.
- Run list by `(organization_id, started_at desc, id desc)` and provider-specific history.
- Quarantine list by `(organization_id, state, created_at desc, id desc)` plus reason and provider filters.
- Active alerts by `(organization_id, state, severity, last_seen_at desc)`.
- Audit history by `(organization_id, subject_type, subject_id, occurred_at desc)`.

## Interfaces, APIs, Endpoints

### Session and operators

- `GET /api/auth/session`, `POST /api/auth/login`, and `POST /api/auth/logout` follow [tech-001](tech-001-runtime-security-and-service-boundaries.md).
- `GET /api/operators` is admin-only and paginated.
- `POST /api/operators` provisions an operator and membership without returning a password hash.
- `PATCH /api/operators/:id` changes display name, role, or active state with CSRF, audit, and session revocation where required.

### Provider configuration

- `GET /api/data-providers` and `GET /api/data-providers/:id` return lifecycle, active revision, health, and sanitized run summaries.
- `POST /api/data-providers` creates a provider and draft revision; `POST /api/data-providers/:id/revisions` replaces the draft.
- `POST /api/data-providers/:id/revisions/:revisionId/test` performs a bounded connection test.
- `POST /api/data-providers/:id/revisions/:revisionId/activate` is admin-only; `POST /api/data-providers/:id/disable` is admin-only.

### Runs and quarantine

- `GET /api/import-runs`, `GET /api/import-runs/:id`, and `POST /api/data-providers/:id/import-runs` expose run history, sanitized counters, and manual triggering.
- `GET /api/quarantine` and `GET /api/quarantine/:id` expose reason, safe field path, lifecycle, source-expiry state, and retry history.
- `POST /api/quarantine/:id/retries` and `POST /api/quarantine/retries` queue single or bounded-filter retries.
- Retry responses return job references and never imply immediate resolution.

### Alerts and operations

- `GET /api/alerts`, `POST /api/alerts/:id/acknowledge`, and `POST /api/alerts/:id/resolve` manage in-admin operational alerts.
- `GET /api/operations/providers/:id/health` returns freshness and quality separately with their supporting counts/timestamps.
- `GET /api/operations/estimated-ev/:packId/explanation` returns sanitized calculation evidence for launch validation.
- `/api/health` remains shallow and unauthenticated; dependency readiness is protected and separate.

## Data Flow

1. The client loads the session before rendering protected routes and redirects unauthenticated users to login.
2. A page fetches a bounded read DTO through `requestJson`; the server validates and authorizes before service access.
3. A mutation includes the session-bound CSRF token and a current revision where concurrency matters.
4. The service commits the state change and audit event, then returns a sanitized domain result.
5. The UI refreshes the affected summary/detail query and announces the outcome through the existing toast/live-region pattern.

## Error Handling and Edge Cases

- `401` redirects protected pages to login only after preserving a safe internal return path; it never loops on the login route.
- `403` keeps the page visible where read permission exists but removes or disables forbidden controls based on server-returned permissions.
- `409` configuration and state conflicts show the current state and require a deliberate refresh/review before resubmission.
- `422` field errors map to labelled fields; global contract or connection-test failures appear in a summary region.
- `503` leaves prior data visible when available, marks it stale, and provides an explicit retry rather than clearing the page.

## Testing and Verification

### API boundary coverage

- Validate every path, query, and body input; reject extra executable adapter values, unsafe endpoints, excessive limits, and invalid transitions.
- Exercise unauthenticated, data-operator, admin, cross-organization, CSRF, stale-revision, and rate-limit cases through Express.
- Prove connection test, activation, disable, manual run, quarantine retry, alert mutation, and operator changes emit correct audit events.
- Assert secrets and raw evidence never appear in any success or failure response.
- Assert unknown API routes and malformed JSON retain the established stable contract.

### Client behavior coverage

- Test login/session bootstrap, route protection, permission-aware controls, aborts, and generic session expiry.
- Test provider forms, connection-test outcomes, activation conflict, duplicate submission prevention, and secret non-echo behavior.
- Test filtered list loading, empty, stale, failure, partial, and pagination states for runs, quarantine, and alerts.
- Test keyboard and screen-reader behavior for dialogs, confirmation, live status, error summaries, and responsive navigation.
- Complete focused package checks and `npm run verify:framework`.

## Open Questions and Risks

- Decide whether operator provisioning uses a generated one-time password or an out-of-band temporary password workflow.
- Confirm which data-operator actions are permitted beyond read, manual import, and quarantine retry.
- Define the exact maximum bulk-retry size and whether an admin-only override is needed.
- Detailed raw JSON viewing is intentionally excluded; operational debugging may need a later privileged, audited evidence workflow.

## Handoff Notes

Build each route vertically with validation, service call, safe response, direct boundary test, client function, and page behavior. Do not expose database rows directly or let UI permission checks substitute for server authorization.
