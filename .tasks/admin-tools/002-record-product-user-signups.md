# Task: Record Product-User Sign-Ups

**ID:** admin-tools/002
**Depends on:** none
**Blocks:** admin-tools/003, admin-tools/005
**Estimated scope:** medium
**Status:** done

## Objective

Every product sign-in leaves a durable user record — identity, how they authenticate, when they first and most recently signed in, and their account standing — so the admin can see who has signed up and act on their accounts.

## Context

Product users sign in to the public frontend through a hosted wallet/social auth provider, and the product backend trusts that provider's tokens. Today no user record exists anywhere: the only trace of a signed-up user is the owner identity key stamped on their saved items (saved repacks and saved collectibles). The admin therefore cannot answer "who has signed up?" at all.

The approved reference admin's model is the template: a user row created at sign-up carrying identity, sign-up source, status, creation time, and last-signed-in time, which the admin later lists, searches, and manages. PackScout's equivalent must be adapted to third-party-token sign-in: there is no registration form, so the record is established the first time an authenticated identity touches the product backend and refreshed on later sign-ins.

Product users and admin operators are deliberately separate identity systems. This task does not merge them; it creates the product-side directory that operator-facing tasks (admin-tools/003/004/005) read and manage.

## Requirements

- When an authenticated product user session is established, a durable user record is created if none exists for that identity, keyed by the stable subject identity the auth provider guarantees (the same identity key already used to own saved items).
- The record captures: the stable identity key, the authentication method/source, whatever human-meaningful identity attributes the auth provider exposes at sign-in (email address and/or wallet address when available — absence is normal and allowed), first-seen time, last-seen time, and an account standing that defaults to active.
- Repeat sign-ins update last-seen (and refresh identity attributes if the provider now exposes more) without creating duplicates, including under concurrent session establishment.
- Account standing supports at least active and suspended values from the start, even though nothing sets suspended until admin-tools/005 — the field must exist so enforcement and admin tooling have a stable contract.
- Identities that own saved items but have no directory record (users who signed up before this task ships and haven't returned) must not break anything: they gain a record on their next sign-in, and consumers of the directory must tolerate saved items whose owner has no record yet.
- User records are private: they are never readable through public/unauthenticated product queries, and an authenticated user can access at most their own record. Only the protected admin integration (admin-tools/003) may enumerate them.
- The product backend exposes two privileged, admin-integration-only reads: a directory enumeration supporting search (by email, wallet address, or subject), recency ordering, bounded pagination, and per-user saved-repack and saved-collectible counts; and a single-record lookup by subject. Both are unreachable by public or ordinary authenticated clients, and access to them is verified by tests.
- The product backend also exposes an authenticated self-standing read: a signed-in user can learn their own current standing (and nothing about anyone else), so the product frontend can reflect suspension (admin-tools/005).
- Recording must not add user-visible friction: a sign-in that fails to write the record must not block the user's session or their existing capabilities (record on a best-effort basis with eventual consistency, or equivalently robust behavior).

## User-Facing Behavior

None visible to product users — sign-in looks and behaves exactly as before. The effect is administrative: from this task onward, sign-ups become visible to tasks that read the directory.

## Interface Contract

A product-user directory record with this logical shape, consumed by admin-tools/003 (listing/search), admin-tools/004 (attribution of saved items), and admin-tools/005 (standing enforcement):

- `subject` — stable identity key, identical to the owner key on saved items
- `authMethod` — sign-in source/provider descriptor
- `email` — optional
- `walletAddress` — optional
- `firstSeenAt`, `lastSeenAt` — timestamps
- `standing` — `active` | `suspended`

The directory guarantees at most one record per subject. Standing is authoritative for enforcement: admin-tools/005 flips it and product-side checks read it.

Read surfaces this task commits the product backend to:

- privileged directory enumeration (search, recency order, bounded pagination, per-user saved-item counts) — consumed by admin-tools/003's server integration;
- privileged single-record lookup by subject — consumed by admin-tools/004 and admin-tools/005;
- authenticated self-standing read — consumed by the product frontend for admin-tools/005's suspended notice.

## Acceptance Criteria

- [x] First authenticated contact from a new identity creates exactly one directory record with correct identity attributes, first/last seen, and active standing.
- [x] A repeat sign-in updates last-seen without creating a duplicate, including when two sessions establish concurrently.
- [x] Unauthenticated and public read paths cannot enumerate or read user records; an authenticated user cannot read another user's record.
- [x] The privileged enumeration read returns correct search results, ordering, bounded pages, and accurate saved-item counts, and is rejected for public and ordinary authenticated callers; the self-standing read returns only the caller's own standing.
- [x] Saved items owned by an identity with no directory record continue to work, and that identity gains a record on its next sign-in.
- [x] Existing saved-items behavior (saving, unsaving, listing own saved items) is unchanged.

## Verification

Backend function tests prove: create-on-first-contact, idempotent update-on-repeat (no duplicates under concurrent establishment), standing defaults to active, access-control denial of public/other-user reads, and the privileged enumeration read's access control, search, pagination, and saved-item-count accuracy. The workspace test command covering the product backend exits 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: `productUsers` stores the full contract shape keyed on the verified Convex token identifier that already owns saved items; `recordSignIn` (public mutation) establishes and refreshes it best-effort, `getMyStanding` (public query) is the self-standing read, and the two privileged reads are Convex internal queries reachable only through an admin-integration HTTP surface authenticated with a deployment secret.
- Divergences: (1) `authMethod` records the verified issuer (or `unknown`), because the hosted provider's access token exposes no per-method claim; email/wallet come from verified claims only (`email`, `wallet_address`) and are normally absent. (2) Repeat sign-ins inside a 60-second window keep the stored `lastSeenAt` to bound write amplification; newly exposed attributes still write immediately, and an attribute is never erased once known. (3) Directory search is bounded prefix matching (case-insensitive for email/wallet, verbatim for the opaque subject) over at most 100 rows per attribute, reported through a `searchTruncated` flag, instead of a full-text index whose test-double semantics differ from production. (4) Saved-item counts are bounded by the enforced 250-per-kind saved-item cap. (5) Frontend wiring of `recordSignIn`/`getMyStanding` is out of this task's write scope and is left to the consuming tasks.
- Verification: `npm run typecheck:convex && npm run test:convex` → exit 0 (6 files, 54 tests passed, including 14 in `convex/productUsers.test.ts` and 12 in `convex/productUserDirectory.test.ts`); `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new findings.
- Verification (frontend wiring): `recordSignIn` is now called by the product frontend, so the first authenticated contact creates a directory record in the running product rather than only under test. `apps/frontend/components/auth/AuthenticatedSignInRecorder.client.tsx` mounts inside `PackScoutAuthBridge` and sends the mutation once per established session (keyed by `convexAuthSessionKey`), skipping signed-out visitors and Convex reconnects; failures are absorbed by `recordSignInBestEffort` so sign-in and saved items are untouched. Covered by `apps/frontend/components/auth/sign-in-recording.test.ts` (8 tests) and the wiring assertions in `apps/frontend/components/auth/auth-boot-boundary.source.test.ts`. `npm run typecheck:frontend && npm run test:frontend && npm run lint:frontend` → exit 0 (42 files, 161 tests passed); `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new findings.
