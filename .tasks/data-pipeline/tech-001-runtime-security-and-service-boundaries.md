# Technical Spec: Runtime, Security, and Service Boundaries

**Spec ID:** tech-001  
**Related tasks:** [data-pipeline/001](001-protect-data-operations.md), [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/005](005-import-cursor-pages-idempotently.md), [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md)  
**Depends on tech specs:** none  
**Spec status:** draft

## Purpose

Establish the first server-side application boundaries for PackScout so the admin API and background importer can share business behavior without coupling browser code to secrets, persistence, or provider implementations.

## Current System Context

- The repository is an npm workspace containing independent `apps/frontend` and `apps/admin` applications.
- The admin server is Express 4 in `apps/admin/server`; it currently exposes only `/api/health` plus stable JSON 404 and error responses.
- The admin client already sends same-origin requests with `credentials: "include"` through `apps/admin/src/api/client.ts`.
- No authentication, database client, shared service package, worker runtime, or queue exists today.
- Repository standards permit a shared package only when real reuse exists; this feature creates that reuse between the admin API and importer.

## Proposed Implementation

### Workspace ownership

Add four server-oriented workspaces and keep their public exports explicit:

- `packages/contracts`: runtime-neutral schemas, DTOs, identifiers, enums, and error codes safe for browser import.
- `packages/database`: PostgreSQL schema, migrations, database client ownership, and repository implementations; server-only.
- `packages/services`: transport-neutral workflows for auth, providers, imports, quarantine, projections, and alerts; server-only.
- `apps/worker`: scheduled import, retry, reconciliation, alert, and retention execution; server-only.

`apps/admin/server` owns HTTP concerns and calls `packages/services`. `apps/admin/src` may import browser-safe types from `packages/contracts`, but it must not import database, service, worker, or provider adapter modules.

### Runtime configuration

Create one validated server configuration loader used by the admin server and worker. It must fail startup for missing or invalid production values and expose only typed values to callers.

Required production settings are the database URL, session-cookie policy, session hashing secret, credential-encryption keyring, actor-pseudonym key, and worker identity. Provider credentials remain database-managed encrypted values rather than process-wide environment variables.

### Authentication and sessions

Implement invite-only operator accounts with `admin` and `data_operator` roles. Provisioning and role changes are admin-only; self-registration and password reset are outside this feature.

Use Argon2id for password hashes. Generate opaque session tokens with a cryptographically secure random source, store only a keyed hash of each token, and send the raw token in a `Secure`, `HttpOnly`, `SameSite=Lax`, path-root cookie. Sessions have absolute and idle expiry, rotate after login and privilege changes, and are revoked on password or role changes.

### Request protection

Install middleware in this order: request ID, security headers, bounded body parsing, origin/CSRF enforcement for mutations, session resolution, rate limiting, route authorization, route handler, stable 404, then sanitized error handling.

Every protected request reloads the operator and current role from persistence. Mutating cookie-authenticated requests require a same-origin `Origin` plus a session-bound CSRF token. Login attempts are rate-limited by normalized email and pseudonymized network key without revealing whether an account exists.

### Credential protection

Encrypt provider credentials with AES-256-GCM using a versioned server keyring. Store ciphertext, nonce, authentication tag, and key version separately from provider configuration revisions. Decryption is restricted to the connection-test and worker request paths, and plaintext must never appear in logs, API responses, audit metadata, or error details.

## Code Changes

### New server packages

- `packages/contracts/src/auth.ts`, `provider.ts`, `imports.ts`, `errors.ts`, and public exports.
- `packages/database/src/schema/*`, `migrations/*`, `client.ts`, and scoped repositories.
- `packages/services/src/auth-service.ts`, `provider-service.ts`, `import-service.ts`, and service dependencies.
- `apps/worker/src/index.ts`, `runtime-config.ts`, `scheduler.ts`, and job handlers.

### Existing application changes

- Extend root workspace scripts with explicit build, typecheck, lint, test, migrate-local, and worker commands.
- Refactor `apps/admin/server/app.ts` to accept injected services and middleware dependencies for direct route tests.
- Extend `apps/admin/src/api/client.ts` to attach the CSRF token to mutation requests and retain the existing stable error behavior.
- Replace the admin shell's “access controls pending” placeholders only after session bootstrap is working.

## Database / Schema Changes

This spec introduces the security tables; domain tables are defined in [tech-002](tech-002-provider-feed-storage-and-history.md).

### `organizations` and membership

Create `organizations(id, slug, name, created_at)` and `operator_memberships(id, organization_id, operator_id, role, created_at, updated_at)`. Even with one launch organization, every operational record is organization-scoped to prevent an unscoped persistence model.

### Operators and sessions

Create `operators(id, email_normalized, display_name, password_hash, state, created_at, updated_at)` and `operator_sessions(id, operator_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at, last_seen_at, revoked_at, created_at)`.

Enforce unique normalized emails. Index active session lookup by `token_hash`, and index membership lookup by `(organization_id, operator_id)`.

### Rate limits and audit events

Create bounded `auth_rate_limits(bucket_key, window_started_at, attempt_count, blocked_until)` and append-only `audit_events(id, organization_id, actor_key, action, subject_type, subject_id, outcome, metadata_json, occurred_at)`.

Audit metadata uses an allowlist and must not contain credentials, cookies, raw provider payloads, email addresses, IP addresses, or stack traces.

## Interfaces, APIs, Endpoints

### Authentication

- `POST /api/auth/login` accepts `{ email, password }`; returns `{ operator, membership, csrfToken }` and sets the session cookie.
- `GET /api/auth/session` returns the current operator, organization membership, permissions, and the stable session-bound CSRF token without mutating session state.
- `POST /api/auth/logout` revokes the current session and clears the cookie.
- `POST /api/operators` and `PATCH /api/operators/:operatorId` are admin-only provisioning and role/state operations.

### Stable errors

Errors retain the current top-level `{ error, code }` contract. Feature routes may add a sanitized `details` object for field errors, retry hints, or a request ID; clients must not depend on unstructured message text.

Use `401 AUTH_REQUIRED`, `403 FORBIDDEN`, `409 CONFLICT`, `422 VALIDATION_FAILED`, and `429 RATE_LIMITED` consistently. Login always returns the same `401 INVALID_CREDENTIALS` response for unknown email, incorrect password, or inactive account.

## Data Flow

1. Express validates the request envelope and resolves the current session, operator, organization, and role.
2. The route converts the request into a contract DTO and calls a service with an explicit organization and actor context.
3. The service enforces permission and state rules again before repository or adapter work.
4. Database repositories scope every read and write by organization ID and return domain results rather than HTTP responses.
5. The route maps the result to a browser-safe DTO and the audit sink records the sanitized outcome.

## Error Handling and Edge Cases

- Expired, revoked, or unknown sessions clear the cookie and return `AUTH_REQUIRED` without exposing the reason.
- A role changed during an active browser session takes effect on the next request; privilege reduction also revokes other sessions.
- A missing credential key version prevents decryption, records a sanitized operational alert, and never falls back to plaintext.
- Database unavailability returns `503 SERVICE_UNAVAILABLE` for dependency-backed routes while `/api/health` stays shallow.
- Replayed CSRF tokens from a different session, missing origins, and cross-origin mutations fail before service execution.

## Testing and Verification

### Direct security coverage

- Login success, generic failure, rate limiting, secure cookie attributes, rotation, expiry, revocation, and logout.
- Admin versus data-operator permissions for account, provider, run, quarantine, and alert operations.
- Cross-organization reads and writes fail even when identifiers are valid in another organization.
- CSRF and origin enforcement cover every mutation method and do not block safe same-origin reads.
- Credential ciphertext changes on rotation and plaintext never appears in returned DTOs, logs, audit events, or errors.

### Repository gates

- Boundary tests prove browser modules cannot import server packages and providers cannot leak into generic services.
- Service tests use injected repositories, clocks, random sources, crypto, and adapters; route tests exercise real middleware.
- Migration tests build a blank database and exercise constraints with focused integration scenarios.
- Run package-level checks while building and finish with `npm run verify:framework`.

## Open Questions and Risks

- Confirm the production secret-manager source for the versioned credential keyring before deployment.
- Confirm initial organization and first-admin bootstrap procedure; it must be an explicit environment-scoped command.
- Argon2 native packaging must be validated in the chosen deployment image.
- DB-backed rate limiting is sufficient for the first admin deployment but may need a shared limiter if API replicas grow materially.

## Handoff Notes

Implement the service and database boundaries before provider-specific adapters. Keep configuration injection explicit so route, service, and worker behavior can be tested without real credentials or network access.
