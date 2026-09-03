# Task: Inspect What a User Has

**ID:** admin-tools/004
**Depends on:** admin-tools/001, admin-tools/003
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

From a user's row in the admin Users area, an administrator can open that user's detail view and see everything the user has in the product today: their identity summary and their saved repacks and saved collectibles, resolved to recognizable catalog information.

## Context

The entirety of a product user's owned data today is two bounded collections: saved repacks and saved collectibles (each capped per user). These are durable, user-owned rows in the product backend, keyed by the same subject identity as the admin-tools/002 directory record, and they reference catalog entries by public identifier.

The catalog itself is versioned: the product serves an active release, and releases are replaced over time. A saved item can therefore reference a catalog entry that no longer exists in the active release. The admin view must stay truthful in that case rather than erroring or silently dropping items — user-owned rows are durable and outlive catalog republication, with one existing exception worth knowing: when a user at the per-kind save cap saves a new item, the product backend prunes their oldest saved row whose reference is absent from the active catalog, so unresolved rows can disappear as a side effect of the user's own saves.

Support and trust workflows drive this: when a user reports a problem or an account looks suspicious, an administrator needs to see what the account actually holds before acting (for example before a suspension via admin-tools/005).

## Requirements

- The user detail view shows the identity summary from the directory record: identity attributes, authentication method, standing, first-seen and last-seen times.
- It lists the user's saved repacks and saved collectibles as two clearly separated collections, ordered newest save first, each showing when the item was saved and resolving each reference against the active catalog to human-recognizable information (display name; for repacks also the vendor and current availability, plus the product's estimated-EV summary when one is available).
- This task owns the privileged product-backend read it needs: a per-subject saved-items read for the admin integration that returns both collections resolved against the active catalog (display fields plus a resolution status per item). Resolution happens in the product backend, which owns the catalog; the admin server shapes and relays, and the browser never queries the product backend directly. The read is unreachable by public and ordinary authenticated clients.
- A saved item whose reference is absent from the active catalog still appears, labeled as no longer in the current catalog, showing its stable public identifier so it remains investigable.
- Collections render bounded: they must handle a user at the per-kind save cap without unbounded payloads or unusable rendering.
- The view is strictly read-only over saved items — no admin capability to add, remove, or edit a user's saved items.
- Access is guarded by the view-product-users permission (admin-tools/001), with the standard forbidden state for everyone else.
- Empty collections, partially resolvable collections, loading, error, and forbidden states are covered accessibly, reusing existing admin patterns.

## User-Facing Behavior

An administrator selects a user in the Users ledger and lands on that user's page: who they are and their standing at the top, then their saved repacks and saved collectibles with names they can recognize from the product, newest saves first. Items that have left the current catalog are visibly marked rather than hidden. A user who has saved nothing shows honest empty states for both collections.

## Interface Contract

- The admin exposes a protected user-detail read, keyed by the subject identity from admin-tools/003's rows, returning the directory record (via admin-tools/002's single-record lookup) plus the two saved-item collections with per-item: stable public identifier, resolution status, resolved display fields when available, and saved-at time, newest first.
- Catalog resolution happens in the product backend's privileged per-subject saved-items read (built by this task); the admin server relays display-ready rows and the browser never queries the product backend directly.
- admin-tools/005 links back to this view as the pre-suspension inspection surface but takes no data dependency beyond the subject identity.

## Acceptance Criteria

- [x] An administrator can open any listed user and see their identity summary and both saved-item collections resolved against the active catalog, ordered newest save first.
- [x] The privileged per-subject saved-items read is rejected for public and ordinary authenticated callers.
- [x] Saved items referencing entries absent from the active catalog appear with a clear unresolved label and their stable identifier.
- [x] A user at the per-kind save cap renders completely and usably; a user with no saves shows distinct empty states.
- [x] Anonymous and data-operator access receives the standard unauthenticated/forbidden outcomes.
- [x] No mutation of saved items is possible through this surface.

## Verification

Admin route behavior tests prove the detail read's authorization matrix and relay shaping; product-backend tests prove the privileged per-subject read's access control and its resolution output, including the unresolved-reference fallback, newest-first ordering, and cap-sized collections; a page-level test covers resolved, unresolved-labeled, and empty renderings. The admin and product-backend test suites and typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: The privileged per-subject saved-items read lives in the product backend behind the existing authenticated POST-only server-to-server surface, the admin server relays a bounded explicit projection guarded by `product_users:view`, and the browser reaches the product backend only through that route.
- Divergences: The read is two internal queries (one per kind) behind one route rather than a single internal query, so an owner at the 250-per-kind cap stays inside one Convex query transaction's read budget. The response adds a `catalogAvailable` flag so an unreadable catalog is never mislabelled as references leaving the catalog.
- Verification: `npm run lint:admin` (0), `npm run typecheck` (0), `npm run test:admin` (0, 142 tests), `npm run test:convex` (0, 162 tests), `npm run build:admin` (0), `npm run scan:framework-standards:ratchet` (0, no new findings).
