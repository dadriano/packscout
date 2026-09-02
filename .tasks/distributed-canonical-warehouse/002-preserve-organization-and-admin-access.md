# Task: Preserve Organization and Admin Access

**ID:** distributed-canonical-warehouse/002
**Depends on:** distributed-canonical-warehouse/001
**Blocks:** distributed-canonical-warehouse/003, distributed-canonical-warehouse/006, distributed-canonical-warehouse/008, distributed-canonical-warehouse/011
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including security, route parity, accessibility, and focused verification
**Status:** in progress

## Start Here

Map the existing login, session, organization, operator, and permission flows to the central `packscout` authority and record the expected state transition for each security-changing operator action.

## Objective

Preserve the current administrator experience and security guarantees while moving all administrator identity, organization access, sessions, rate limits, and audit history into the clean central database.

## Context

The admin application currently uses PackScout-managed email and password authentication, server-side sessions, organizations, and fixed roles. The new distributed warehouse keeps that behavior. Provider databases contain no administrator credentials or memberships and trust only authorized server-side commands carrying validated soft actor references.

This task covers `/login`, `/`, `/operators`, sign-out, the protected application shell, and unknown admin routes. Product-user identity and catalog saves remain owned by the frontend and Convex boundary, not by the admin access model.

## Requirements

### Central identity model

- Store `ORGANIZATIONS`, `ADMIN_PRINCIPALS`, `ADMIN_MEMBERSHIPS`, `ADMIN_SESSIONS`, `ADMIN_AUTH_RATE_LIMITS`, and append-only `ADMIN_AUDIT_EVENTS` in `packscout`.
- Keep fixed membership roles `admin` and `data_operator`; administrators receive all current permissions, while data operators receive provider viewing, import starting, and quarantine retry permissions.
- Scope every authenticated central read and write to the active organization membership.
- Store password verifiers and session tokens only in protected forms; never return them through an API, log, audit detail, or browser state.
- Preserve last-active-admin and self-disable protections.

### Session security

- Use server-side session revocation, idle and absolute expiration, and production cookies that are `HttpOnly`, `Secure`, `SameSite=Lax`, and host-bound.
- Require a trusted `Origin` for login and every mutation; authenticated mutations also require the session CSRF token.
- Revoke active sessions when an operator password, role, or lifecycle state changes.
- Apply durable login throttling with generic credential failures and a bounded `Retry-After` response.
- Trust forwarded client addresses only from explicitly configured trusted proxies; untrusted forwarding headers cannot change a rate-limit identity.
- Revoke the server session before clearing the browser cookie during sign-out.

### Admin behavior

- Preserve safe `returnTo`, expired-session messaging, role-aware navigation, workspace identity, service status, theme behavior, and accessible not-found handling.
- Prevent a stale session response from replacing or clearing a newer browser session or CSRF state during overlapping authentication requests.
- Allow administrators to search, filter, create, update, enable, disable, change roles, and rotate passwords for operators.
- Give data operators an explicit forbidden state for operator management rather than hiding an authorization failure behind an empty result.
- Return stable structured errors shaped as `{ error, code, details? }`, including direct behavior for `401`, `403`, `404`, `409`, `422`, `429`, and `503`.
- Reject unknown object fields, malformed identifiers, oversized inputs, malformed JSON, and unknown API routes with stable safe codes.

### Error compatibility

- Own one shared admin compatibility matrix that fixes each current route family, HTTP status, stable code, and browser-safe details shape.
- Include current codes such as `CONFIG_REVISION_CONFLICT`, `PROVIDER_LIFECYCLE_CONFLICT`, `INVALID_OPERATION_CURSOR`, `IMPORT_RUN_NOT_FOUND`, `QUARANTINE_NOT_FOUND`, and `ALERT_NOT_FOUND` plus the existing Data Feed Lab failures.
- Require provider, run, quarantine, alert, health, and Data Feed Lab tasks to consume the matrix rather than inventing route-local replacements.
- Change a code/status pair only through one atomic contract, server, UI, and test update; do not add aliases or dual error responses.

### Accessibility and audit

- Keep keyboard-operable navigation and forms, visible focus, labelled fields, live loading and outcome announcements, and status text that does not rely on color.
- Move focus to actionable validation or service errors and preserve entered values after a recoverable failure.
- Require explicit confirmation through a labelled modal with initial focus, focus trapping, Escape dismissal, and focus restoration for destructive operator state changes.
- Record login, logout, authentication failure, operator security change, session revocation, authorization refusal, and service failure as bounded audit events.
- Never include passwords, password hashes, raw session or CSRF tokens, or unbounded request bodies in an audit event.

## User-Facing Behavior

Operators keep the existing login and application shell. Administrators can manage operators. Data operators see the operational areas permitted by their role and receive a clear forbidden screen if they open administrator-only operator management. Expired sessions return to login with a concise explanation, and a failed logout does not falsely present the user as signed out.

## Interface Contract

An authenticated admin context contains `principalId`, `membershipId`, `organizationId`, fixed `role`, derived permissions, session ID, and CSRF validation state. Browser requests never supply organization ownership as authority.

Security-changing operator commands return the updated safe operator projection and the number of sessions revoked. Conflicts use stable codes for duplicate email, last-active-admin protection, stale row version, and self-disable protection.

## Acceptance Criteria

### Access acceptance

- [ ] Login, safe return, session bootstrap, expiration, sign-out, home, theme, and not-found flows match current behavior.
- [ ] Administrators can complete every current operator-management flow, and data operators cannot mutate operators.
- [ ] Cross-organization reads and writes fail without disclosing whether the target exists.
- [ ] Role, password, and lifecycle changes revoke affected sessions transactionally.
- [ ] Last-active-admin and self-disable protections return stable conflict responses.

### Security acceptance

- [ ] Origin, CSRF, cookie, throttling, idle-expiry, absolute-expiry, and revocation behavior have direct tests.
- [ ] Trusted-proxy address handling and stale-versus-new session response races have direct tests.
- [ ] Structured `401`, `403`, `404`, `409`, `422`, `429`, and `503` responses remain browser-safe.
- [ ] Credentials, hashes, and raw tokens do not appear in browser responses, logs, or audit events.
- [ ] Login, operator, and shell states are keyboard accessible and announced without color-only meaning.
- [ ] Focused authentication and operator tests pass against the clean central database.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Existing central admin table names and security behavior are preserved exactly as contracted.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
