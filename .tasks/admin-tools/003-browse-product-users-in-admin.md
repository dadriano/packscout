# Task: Browse Product Users in the Admin

**ID:** admin-tools/003
**Depends on:** admin-tools/001, admin-tools/002
**Blocks:** admin-tools/004, admin-tools/005
**Estimated scope:** medium
**Status:** todo

## Objective

Administrators can open a Users area in the admin, see everyone who has signed up for the product, and search and page through them — the entry point for inspecting what a user has (admin-tools/004) and managing their standing (admin-tools/005).

## Context

The admin currently manages only operator accounts; product sign-ups are invisible to it. admin-tools/002 establishes the product-user directory; this task gives administrators a window into it.

The approved reference admin's users page is the pattern to port: a searchable ledger of every signed-up user ordered by recency, showing identity, sign-up source, status, created and last-signed-in times, with management affordances inline. PackScout adapts that to its stack and to the cross-system reality that product-user data lives with the product backend, not in the admin's own database.

This is the admin's first integration with product-side data. The admin browser must keep talking only to the admin's own protected API; the admin server owns whatever server-to-server integration reads the directory, and any credentials for it stay server-side, following the same secret-handling rules as provider credentials.

## Requirements

- Add a Users destination to the admin navigation, visible only to operators holding the view-product-users permission from admin-tools/001, and guarded server-side by that permission.
- List signed-up users with: human-meaningful identity (email and/or wallet address when present, otherwise the stable subject key in a bounded display form), authentication method, standing, first-seen and last-seen times, and how many repacks and collectibles they have saved.
- Order by recency (most recently seen first) and paginate with bounded page sizes so growth never requires unbounded responses.
- Support search by email, wallet address, or subject key; show a clear no-match state distinct from the true empty state ("no users have signed up yet").
- Represent users whose directory record lacks optional attributes gracefully — a record with no email and no wallet still renders an identifiable, selectable row.
- Cover loading, empty, no-match, error, and forbidden states accessibly, reusing the admin's existing shell, table/ledger, status, and empty-state patterns rather than inventing new ones.
- If the product-backend integration is unavailable, the page degrades to a clear, non-destructive error state; the failure never exposes integration credentials or raw backend errors to the browser.
- Product-user personal data never appears in admin logs or metrics beyond what the existing observability conventions allow for audit-relevant identifiers.

## User-Facing Behavior

An administrator clicks Users in the admin navigation and sees a ledger of sign-ups, newest activity first, each row showing who the user is, how they signed in, their standing, when they arrived, when they were last seen, and how much they've saved. Typing into search narrows the ledger by email, wallet, or subject key. Selecting a row leads to the user's detail view (admin-tools/004). A data operator sees no Users navigation entry and gets the standard access-restricted state on direct navigation.

## Interface Contract

- The admin exposes a protected, paginated user-listing endpoint guarded by the view-product-users permission, returning rows shaped from the privileged directory-enumeration read admin-tools/002 commits the product backend to (which already carries search, ordering, pagination, and saved-item counts), with a stable cursor/pagination contract consistent with the admin's existing paginated endpoints.
- Row identity carries the stable subject key so admin-tools/004 (detail) and admin-tools/005 (standing actions) can target a specific user.
- The admin server ↔ product backend read path is server-side only; its credentials follow the same handling rules as provider secrets (never in browser bundles, responses, or logs).

## Acceptance Criteria

- [ ] An administrator can list, search, and page through all signed-up users with accurate identity, standing, timestamps, and saved-item counts.
- [ ] Anonymous and data-operator requests to the listing endpoint receive the standard unauthenticated/forbidden errors, and the data-operator UI shows no Users navigation.
- [ ] Records missing email and wallet render usable rows keyed on the subject identity.
- [ ] Loading, empty, no-match, integration-failure, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.
- [ ] No product-backend integration credential or raw backend error body reaches the browser.

## Verification

Admin route behavior tests prove the authorization matrix (anonymous, data operator, administrator), pagination bounds, search filtering, and sanitized failure mapping for the user-listing endpoint; page-level tests cover the empty/no-match/forbidden states. The admin lint, typecheck, test, and build commands exit 0.
