# Task: Extend Operator Access Control for User Administration

**ID:** admin-tools/001
**Depends on:** none
**Blocks:** admin-tools/003, admin-tools/004, admin-tools/005
**Estimated scope:** small
**Status:** done

## Objective

The admin's existing role and permission model gains a user-administration capability so that product-user features can be granted to administrators and denied to everyone else, with the same server-side enforcement rigor as existing protected operations.

## Context

The admin already has a working operator identity system: administrator-provisioned email/password accounts, server-side sessions, CSRF protection, login rate limiting, and two roles (`admin` and `data_operator`) that map to a fixed permission vocabulary (operator management, provider viewing/management, secret management, import start/retry, archival). Every protected route resolves the session, re-checks the account against the database, and enforces a named permission server-side. That design already follows the approved reference admin's login, session, and guard patterns.

This feature adds a new administrative domain — managing the product's signed-up users — and the reference admin gates its equivalent user directory to top-level administrators only. Product-user records contain personal data (email addresses, wallet-linked identities), which data operators have no need to see: the pipeline deliberately pseudonymizes actor identities everywhere else.

This task extends the permission vocabulary and role mapping so later tasks (admin-tools/003 browsing users, admin-tools/005 suspending users) can attach to named permissions instead of inventing ad-hoc checks.

## Requirements

- Add distinct permissions for viewing product users and for managing product users (mutating their standing) to the shared permission vocabulary, following the existing naming conventions.
- Grant both permissions to the `admin` role only. `data_operator` receives neither; the role's existing capabilities are unchanged.
- The authenticated session exposed to the admin browser reflects the new permissions the same way existing permissions are exposed, so navigation and page gating can key off them.
- Server-side authorization for the new permissions flows through the same session-resolution and permission-check boundary used by existing protected routes — no parallel guard mechanism.
- Direct requests by a data operator or anonymous client to any future user-administration route must produce the same stable unauthenticated/forbidden error shapes as existing protected routes.
- The admin's existing audit-event conventions must accommodate user-administration actions (acting operator, target subject, action, timestamp, outcome) without secrets or password material. Emitting those audit events is owned by the tasks that introduce user-administration mutations (admin-tools/005); this task only ensures the conventions and vocabulary support them.

## User-Facing Behavior

No standalone user-visible change yet. Once dependent tasks land: administrators see the user-administration area in the admin navigation; data operators do not see it, and navigating directly to it shows the existing access-restricted state rather than the content.

## Interface Contract

- The permission vocabulary gains two named permissions — one read-oriented (view product users) and one write-oriented (manage product users) — resolvable through the same permission-check API existing routes use.
- Role→permission mapping: `admin` holds both; `data_operator` holds neither.
- Tasks admin-tools/003, admin-tools/004, and admin-tools/005 guard their routes with these permissions and rely on the session user object exposing them to the browser for navigation gating.

## Acceptance Criteria

- [x] The two user-administration permissions exist in the shared vocabulary and are granted to `admin` and withheld from `data_operator`.
- [x] A route guarded by either new permission returns the standard unauthenticated error to anonymous requests and the standard forbidden error to data-operator requests, verified by direct boundary tests.
- [x] The browser session payload for an administrator includes the new permissions; a data operator's session payload does not.
- [x] Existing role capabilities and permission checks are unchanged (no regressions in the existing authorization matrix).

## Verification

The admin test suite passes with new direct tests covering the authorization matrix for the new permissions: anonymous → unauthenticated, data operator → forbidden, administrator → allowed, plus an assertion that the data-operator role's permission set is otherwise unchanged. The workspace typecheck and test commands exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Added `product_users:view` and `product_users:manage` to the shared `operatorPermissions` vocabulary in `packages/contracts/src/auth.ts`, made the role→permission grant contract-owned (`operatorRolePermissions` / `permissionsForOperatorRole`) with both new permissions granted to `admin` only, pointed the existing `AuthService` role resolution at that single source of truth so sessions and the browser session payload carry them automatically, and covered the matrix with a direct boundary test that guards routes through the existing `createRequireSession` middleware.
- Divergences: The role grant previously lived as duplicated literal arrays inside `packages/services/src/auth-service.ts`; granting a permission to `admin` is impossible without it, so that mapping was moved into the contracts package and `auth-service.ts` now reads it (a 20-line change that removes duplication rather than adding a parallel mechanism). No new guard mechanism was introduced, and no admin browser code was changed — `AuthSessionResponse.permissions` already exposes the vocabulary to the SPA. The `AuthAuditEvent.action` union in the services package is left untouched; admin-tools/005 extends it when it emits user-administration audit events, and the existing event shape already carries acting operator, target subject, action, timestamp, outcome, and secret-free metadata.
- Verification: `npm run typecheck:contracts && npm run typecheck:admin && npm run test:contracts && npm run test:admin` → exit 0 (contracts 52/52 pass, admin 69/69 pass). `npm run scan:framework-standards:ratchet` → 0 findings, 0 new. Additionally `npm run typecheck:services`, `npm run test:services` (148/148 pass), `npm run lint:contracts`, `npm run lint:services`, and `npm run lint:admin` all pass. The new tests were mutation-checked: removing the two permissions from the `admin` grant fails 2 contracts tests and 3 admin tests.
