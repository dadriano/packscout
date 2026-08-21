# Task: Suspend and Reinstate Product Users

**ID:** admin-tools/005
**Depends on:** admin-tools/001, admin-tools/002, admin-tools/003
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

Administrators can suspend a product user and later reinstate them; while suspended, the user's authenticated product capabilities fail closed, without destroying any of their data.

## Context

The approved reference admin's account-control pattern is the template: disabling an account is a reversible status flip on the user record, there is no hard delete, and enforcement is fail-closed — protected surfaces re-check the authoritative database status rather than trusting a previously issued session, so revocation takes effect even against live sessions.

For PackScout, product users authenticate through a third-party provider the admin cannot revoke, so enforcement lives where the product backend authorizes user actions: the standing on the admin-tools/002 directory record is authoritative, and authenticated capabilities consult it. The only authenticated product capabilities today are saving and unsaving repacks and collectibles (and reading one's own saved items); enforcement must cover whatever authenticated surface exists when this ships, and the pattern must be the default for future authenticated capabilities.

Public browsing is unaffected by design — the catalog is public to signed-out visitors, so suspension removes signed-in privileges, not access to public content.

## Requirements

- From a user's row or detail view in the admin Users area, an administrator holding the manage-product-users permission (admin-tools/001) can suspend an active user and reinstate a suspended one.
- Both actions require explicit confirmation stating the consequence (suspension: the user's signed-in capabilities stop working until reinstated; their saved data is kept). No hard-delete action exists anywhere in the flow.
- Suspension flips the directory record's standing to suspended; reinstatement flips it back to active. The Users ledger and the user detail view reflect the new standing immediately.
- Enforcement is fail-closed and server-side in the product backend: while standing is suspended, authenticated mutations (saving/unsaving items) are rejected with a stable, distinguishable outcome, and standing is checked against the authoritative record at request time — a session established before suspension gains nothing. "Fail-closed" means the check trusts the database record over the session, not that missing records deny access.
- An identity with no directory record (normal per admin-tools/002: pre-existing users who haven't returned, or a best-effort record write that hasn't landed) is treated as active standing — only an explicitly suspended record blocks. Suspension therefore requires the record to exist, which it does for any user visible in the admin directory.
- A suspended user who signs in or attempts a blocked action sees a clear, non-technical notice in the product that their account is suspended; public browsing continues to work for them exactly as for signed-out visitors.
- Suspension never deletes or mutates the user's saved items; reinstatement restores their capabilities with all saved data intact.
- Every suspend and reinstate action produces an audit record (acting operator, target subject, action, timestamp, outcome) per the admin's audit conventions.
- Repeated or conflicting actions are safe: suspending an already-suspended user (or two administrators acting concurrently) converges without error corruption, and the outcome states the resulting standing.
- Data operators and anonymous clients receive the standard forbidden/unauthenticated outcomes for both actions; the controls are absent from their UI.

## User-Facing Behavior

In the admin, a Suspend control appears on active users and a Reinstate control on suspended ones. Choosing either opens a confirmation explaining exactly what changes; on success a toast confirms and the standing badge updates. In the product, a suspended user browsing publicly notices nothing, but signing in surfaces a plain notice that the account is suspended, and save buttons no longer take effect for them; after reinstatement everything works again with their saved items untouched.

## Interface Contract

- The admin exposes protected suspend and reinstate mutations keyed by the subject identity, guarded by the manage-product-users permission, returning the resulting standing; conflicts resolve to the authoritative current standing rather than an opaque failure.
- The product backend's authenticated write paths consult the directory record's standing at request time and reject with a stable suspended-account outcome the frontend can distinguish from other failures; a missing record evaluates as active.
- The frontend learns standing at session establishment through the authenticated self-standing read admin-tools/002 exposes, and additionally maps the blocked-mutation outcome to the suspended notice — neither path exposes internals.

## Acceptance Criteria

- [x] An administrator can suspend and reinstate a user with confirmation, immediate standing updates in the admin, and audit records for both actions.
- [x] While suspended, the user's save/unsave mutations are rejected server-side even on a session established before the suspension, and the product shows the suspended notice.
- [x] Reinstatement restores full signed-in behavior with all previously saved items intact.
- [x] Duplicate/concurrent suspend or reinstate actions converge safely to a correct standing.
- [x] An identity with no directory record retains full authenticated capabilities (missing record = active standing).
- [x] Data operators and anonymous clients cannot perform either action and see no controls for them.

## Verification

Product backend tests prove suspended-standing rejection of authenticated mutations (including with a pre-suspension session), missing-record-evaluates-as-active, and clean reinstatement; admin route behavior tests prove the permission matrix, confirmation-backed mutations, convergence on repeat actions, and audit emission. The workspace test suites and typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: Reversible, database-authoritative status flip with fail-closed server-side enforcement re-read at request time, an audited manage-gated admin control, and a plain product notice — exactly the reference admin's account-control pattern, with no hard delete anywhere.
- Divergences: none. The self-read `savedItems.getSavedItemIds` deliberately stays open while suspended (the task scopes rejection to authenticated writes, and "saved data is kept" requires the owner can still see it). The audit record stores the target as a pseudonymous reference in metadata rather than in `audit_events.subject_id`, because that column is a workspace UUID and a hosted-provider subject key is issuer-qualified personal data; this follows the admin's existing actor-pseudonymization convention.
- Verification: `npm run lint:admin` EXIT 0; `npm run typecheck` EXIT 0; `npm run test:admin` EXIT 0 (155 pass, 0 fail); `npm run test:convex` EXIT 0 (23 files, 167 pass); `npm run test:frontend` EXIT 0 (190 pass, 0 fail); `npm run build:admin` EXIT 0; `npm run scan:framework-standards:ratchet` EXIT 0 (0 new findings, 0 grown modules). Also confirmed green: `npm run lint:frontend`, `npm run lint:contracts`, `npm run check:boundaries`, `npm run check:docs`.
