# Task: Browse Product Users in the Admin

**ID:** admin-tools/003
**Depends on:** admin-tools/001, admin-tools/002
**Blocks:** admin-tools/004, admin-tools/005
**Estimated scope:** medium
**Status:** done

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

- [x] An administrator can list, search, and page through all signed-up users with accurate identity, standing, timestamps, and saved-item counts.
- [x] Anonymous and data-operator requests to the listing endpoint receive the standard unauthenticated/forbidden errors, and the data-operator UI shows no Users navigation.
- [x] Records missing email and wallet render usable rows keyed on the subject identity.
- [x] Loading, empty, no-match, integration-failure, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.
- [x] No product-backend integration credential or raw backend error body reaches the browser.

## Verification

Admin route behavior tests prove the authorization matrix (anonymous, data operator, administrator), pagination bounds, search filtering, and sanitized failure mapping for the user-listing endpoint; page-level tests cover the empty/no-match/forbidden states. The admin lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: none
- Follow-up closed after review: the two server-only integration variables (`PACKSCOUT_ADMIN_DIRECTORY_URL`, `PACKSCOUT_ADMIN_DIRECTORY_TOKEN`) are now documented in `README.md`, including that the secret must match the Convex deployment, that neither belongs in a browser-visible variable, and that leaving both unset degrades to the bounded "not connected" state. `npm run check:docs` passes.
- Alignment: Ported the reference users ledger onto the admin's own template and paginated-read conventions, with the product backend reached only through a server-side integration whose bearer secret stays in server configuration.
- Divergences: The listing endpoint is `POST /api/product-users/list` rather than a GET with a query string, because search terms and subject keys are personal data and must not travel in URLs, browser history, or access logs — this matches the product backend's own POST-only admin surface; the cursor/limit/nextCursor contract is otherwise the admin's usual one. Rows do not yet link to a detail view, since that route arrives with admin-tools/004; each row carries its stable subject so the link can be added there. Integration configuration is optional and never throws at startup, so an absent or unusable pair degrades to a bounded "not connected" state instead of taking the admin down. The integration was exercised against the documented `convex/http.ts` request/response contract with a stubbed transport; no live deployment was contacted.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin` exit 0 (102 admin tests pass, 21 of them new/updated for this task); `npm run scan:framework-standards:ratchet` reports 0 findings and 0 new findings; `npm run check:framework` passes; `npm run lint:contracts`, `npm run typecheck:contracts`, and `npm run test:contracts` pass (61 tests). A static render of the real page components with the real admin stylesheets was checked in the browser at 1280px, 1100px (dark theme), and 375px: `document.documentElement.scrollWidth` equals `clientWidth` at every width, with no overflowing elements.
