# Task: Protect Data Operations

**ID:** data-pipeline/001  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** none  
**Blocks:** [data-pipeline/004](004-manage-provider-configurations.md), [data-pipeline/011](011-manage-providers-in-admin.md), [data-pipeline/012](012-operate-imports-in-admin.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout operators can sign in to the admin with administrator-provisioned email/password accounts, and every data-operation capability is enforced server-side according to the administrator or data-operator role.

## Context

The PackScout repository has an admin shell but no real authentication or authorization. This is the first protected and mutating admin feature, so it must establish a durable single-organization identity boundary instead of relying on hidden navigation or network placement.

The approved behavior follows the reference admin pattern: an email/password login form, generic credential errors, login rate limiting, database-backed role rechecks, session regeneration after successful authentication, secure server-side sessions, and logout. PackScout has no public registration. Administrators provision and rotate operator credentials through protected operations and deliver credentials out of band. Emailed invitations, self-service activation, and self-service password recovery are outside this feature.

## Requirements

### Identity and access

- Support administrator-provisioned accounts with normalized unique email addresses, securely hashed passwords, an active or disabled status, and exactly one role: `admin` or `data_operator`.
- Allow only administrators to provision accounts, rotate credentials, change roles, and disable accounts; prevent the last active administrator from removing the system's remaining administrative access.
- Authenticate with email and password, return the same invalid-credentials response for unknown emails and incorrect passwords, rate-limit repeated attempts, and never log passwords, hashes, cookies, or credential bodies.
- Provide a protected administrator account-management view for creating operators, assigning roles, rotating credentials, and disabling access; initial or rotated credentials are entered by the administrator and delivered out of band.

### Session and authorization

- Regenerate the session identifier after login, store sessions server-side, issue HTTP-only same-site cookies, require secure cookies in production, expire sessions after a bounded period, and invalidate the session on logout or account disablement.
- Re-read the account status and authoritative role at protected request boundaries so a stale session cannot preserve revoked access.
- Allow administrators to manage provider configurations, bearer secrets, account access, and archival actions; allow data operators to view provider state and start or retry imports without viewing or changing secrets.
- Return stable structured errors for unauthenticated, forbidden, invalid, rate-limited, conflict, and failed requests.
- Keep browser code independent from server authentication, password, session-store, and database modules.

## User-Facing Behavior

An anonymous visitor to the admin sees a focused email/password sign-in page. Submitting valid credentials restores the requested admin location; invalid credentials produce one generic error without revealing whether an account exists. Loading, submitting, rate-limited, disabled-account, restricted, and session-expired states are visible and accessible. Authenticated users can log out, and users without the required role see an access-restricted state rather than protected content.

Administrators have a protected operator-access view for creating accounts, setting initial credentials, assigning roles, rotating credentials, and disabling access. Password values are never shown after submission and are delivered to the operator outside PackScout.

## Interface Contract

The protected boundary exposes a session user containing `id`, normalized `email`, `status`, and `role`. Login accepts `email` and `password`; logout invalidates the current session; session lookup returns the current authorized user or a stable unauthenticated error. Authorization decisions use the database account record as the source of truth. Downstream data-operation routes receive only an authenticated actor ID and authoritative role, never a password or password hash.

Account provisioning and credential rotation return the affected account identity and status without returning stored password material. Audit records identify the acting administrator, target account, action, timestamp, and outcome without secret values.

## Acceptance Criteria

- [x] Anonymous, disabled, data-operator, and administrator requests receive the authorization outcomes defined in the matrix, with direct boundary tests for every protected mutation.
- [x] Successful login regenerates the session, secure cookie behavior matches the environment, repeated failures are rate-limited, and error responses do not disclose account existence.
- [x] Account provisioning, credential rotation, role changes, disablement, logout, and server-side role rechecks work without exposing secrets to browser bundles, responses, logs, or audit payloads.
- [x] The login and restricted states are keyboard-operable, labelled, responsive, and announce validation or authentication failures accessibly.
- [x] Browser/server and frontend/admin boundaries remain intact and the repository's canonical verification gate passes.

## Spec Compliance

- The admin runtime now composes durable PostgreSQL-backed operators, sessions, rate limits, and audit events behind service interfaces; the embedded local runtime uses the same schema and service boundary with an explicitly local first-admin fixture.
- The authenticated HTTP boundary rechecks account status and role, rotates and revokes opaque sessions, enforces same-origin CSRF protection, and emits stable structured errors without credential or secret values.
- Administrators can provision, rotate, re-role, and disable operators. Transactional persistence prevents removal of the last active administrator and revokes sessions on security changes.
- Browser walkthroughs covered login, logout, desktop and mobile operator management, data-operator navigation restrictions, direct-route denial, keyboard dismissal, and responsive overflow.
- Direct auth, route, client race-condition, persistence, boundary, lint, typecheck, build, and canonical framework checks pass.
