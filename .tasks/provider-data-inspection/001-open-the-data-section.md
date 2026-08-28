# Task: Open the Data Section to Operators

**ID:** provider-data-inspection/001
**Depends on:** none
**Blocks:** provider-data-inspection/003, provider-data-inspection/005, provider-data-inspection/009
**Estimated scope:** small
**Status:** done

## Objective

Operators who hold a new read-only data-inspection permission see a "Data" section in the admin sidebar with three destinations — Canonical, Published, and Compare — and every server route this feature adds refuses callers who lack that permission.

## Context

The admin console today groups its destinations into two sidebar sections: a workspace section (Overview, Operators, Users, Allowlist, Messages) and a data-pipeline section (Status, Providers, Import Runs, Quarantine, Background Work, Workers, Alerts). Every destination is declared exactly once in a single table that the sidebar, the document title, and the breadcrumb trail all read from; adding a page means adding a row there and a route, never a second per-page label table. Access is controlled by a role-to-named-permission vocabulary: an operator holds either the `admin` or the `data_operator` role, and each role expands to a fixed set of named permissions (`providers:view`, `operators:manage`, `product_users:view`, and so on). Routes name the permission they require and fail closed.

This feature adds surfaces that expose *record content* — canonical business records held in PostgreSQL and their published counterparts in the product backend. The existing provider-configuration screens deliberately do not do that. Giving the new surfaces their own named permission keeps the boundary explicit and auditable, and lets the grant be withdrawn later without touching provider configuration access.

Everything this feature adds is read-only. No task in it introduces a mutation, so the permission is a view permission and there is no paired manage permission.

## Requirements

- A new named permission for read-only data inspection joins the operator permission vocabulary and is granted by both the `admin` and the `data_operator` role. Existing sessions gain it from their role; nothing is backfilled into stored grants.
- A new sidebar section labelled "Data" holds three destinations — Canonical, Published, and Compare. The whole section is absent, not disabled, for an operator without the permission.
- The three destinations are declared in the same single destination table the rest of the admin uses, so their sidebar labels, document titles, and breadcrumbs all derive from one declaration.
- Every server route added by this feature authenticates first, then requires the new permission, and answers a caller who lacks it with a structured forbidden error — never a redirect, an empty result set, or a silently truncated response.
- Deep-linking to one of the three routes without the permission produces the same forbidden treatment the rest of the admin already uses for permission-gated pages.
- Until the later tasks fill them in, the three destinations render an honest placeholder that says what the surface will show. A route that resolves to nothing is not acceptable.

## User-Facing Behavior

An administrator or data operator signing in sees a third sidebar group, "Data", holding Canonical, Published, and Compare. Selecting one navigates to that surface, the document title and breadcrumbs update, and the sidebar entry marks itself active. An operator whose role no longer carries the permission does not see the group at all, and pasting one of its URLs lands on the admin's standard "you do not have permission" treatment rather than a blank screen.

## Interface Contract

- The permission name is exported from the shared permission vocabulary and is what tasks 003, 005, and 009 name on their routes. Those tasks must not invent a second permission or reuse `providers:view`.
- The three route paths are fixed here so later tasks do not collide: `/data/canonical`, `/data/published`, and `/data/compare`. Provider-scoped and record-scoped views live beneath those paths.
- A reusable route guard (or the existing per-route permission declaration, if that is what the codebase already provides) is what tasks 002, 004, 006, 007, and 008 attach their endpoints to. Whatever the shape, the permission check is declared once per route and not re-implemented per handler.

## Acceptance Criteria

- [x] Both operator roles resolve to a permission set containing the new permission, and the permission vocabulary lists it exactly once.
- [x] The "Data" sidebar section, with its three destinations, appears for an operator holding the permission and is entirely absent for one who does not.
- [x] Requesting any route added by this feature without the permission returns a structured forbidden response, and with the permission returns a success shape.
- [x] The three destinations produce correct document titles and breadcrumb trails from the single destination declaration.
- [x] Navigating directly to a Data route without the permission renders the admin's standard forbidden treatment.

## Verification

A route-level test proves a session lacking the permission is refused with the forbidden status and one holding it is admitted, and a navigation test proves the section is hidden without the permission and present with it. The admin test suite and the workspace typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented as specified. `data_inspection:view` joins the operator permission vocabulary and is granted to both `admin` and `data_operator`; the "Data" sidebar section holds the three destinations at the contracted paths `/data/canonical`, `/data/published`, `/data/compare`.
- Divergences: the admin destination table keyed titles and breadcrumbs off the first path segment only, which cannot represent three siblings under one prefix. Extended `AdminDestination.segment` to carry a full path and resolved titles/breadcrumbs longest-match-first rather than moving the surfaces to top-level single segments, which would have lost the grouping the task's interface contract fixed. Existing single-segment destinations are covered by regression tests.
- Additional surface: `GET /api/data-inspection/scope` serves the comparison-scope facts (which canonical kinds have published counterparts) from a single shared contract. Tasks 005, 006, and 009 all need this and would otherwise each restate it.
- Verification: `npm run test:admin` (365 pass), `npm run test:contracts` (220 pass), `npm run typecheck:contracts`, `npm run typecheck:admin`, `npm run scan:framework-standards:ratchet` (0 new findings).
