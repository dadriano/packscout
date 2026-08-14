# Task: Establish the Branded App Shell

**ID:** repack-dashboard/004
**Depends on:** none
**Blocks:** repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/009, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 2–4 days for one builder, including theme and navigation verification
**Status:** done

## Start Here

Render the approved PackScout light logo in a shared header with Dashboard and Learn links, then verify the same hierarchy with the approved dark logo.

## Objective

Replace the placeholder Basecamp shell with the persistent PackScout application frame used by Dashboard, All Packs, and Learn.

## Context

The versioned final light and dark Dashboard comps under `docs/design-comps/packscout-frontend/` establish a compact top navigation with PackScout branding, global pack search, Dashboard/Learn destinations, public freshness, and light/dark control. The existing frontend is a single placeholder page with a forest-and-orange visual system; none of its product copy or theme is retained.

V1 remains public and anonymous. The header contains no account, bookmark, notification, saved-view, or command-palette behavior.

## Requirements

### Navigation and Routes

- Make `/` the Dashboard Overview, `/packs` the All Packs view, `/learn` the guide index, and `/learn/:slug` an article destination.
- Keep Dashboard active for both `/` and `/packs`; expose Overview and All Packs as parallel view tabs within Dashboard.
- Use links for destinations and tab semantics for the two Dashboard views.
- Preserve usable browser back, forward, refresh, and direct-link behavior.
- Give unknown routes and unknown Learn article slugs a not-found outcome.

### Header Utilities

- Use the approved horizontal logo variant for the active theme with required clear space and no recoloring or distortion.
- Provide one labeled search field whose placeholder names packs, platforms, and categories.
- Make Command/Control+K focus the search field without opening a command palette or intercepting typing in another input.
- Reserve a stable public status area for updated, delayed, and unavailable snapshot states.
- Keep utility controls operable without authentication.

### Theme Behavior

- Match the supplied near-white light surface and deep navy-black dark surface with violet as the primary interaction accent.
- Start from the operating-system color preference when the device has no explicit PackScout choice.
- Persist an explicit light or dark choice on the current device only.
- Keep content and feature parity across themes, including all four KPI cards.
- Update browser theme metadata without a visible flash of the wrong theme.

### Page Foundation

- Use a centered, fluid application canvas that supports the dense desktop comp without page-level horizontal overflow.
- Provide consistent title, disclaimer, navigation, content, and status regions across public routes.
- Keep “Estimated EV · Not financial advice.” visible on Dashboard views.
- Use the same semantic theme tokens for focus, text, borders, surfaces, actions, and metric states.
- Respect reduced motion for theme and navigation transitions.

## User-Facing Behavior

Users can move among Overview, All Packs, and Learn, focus global search from the keyboard, and switch themes. Their theme choice persists on that device. No sign-in prompt interrupts exploration.

## Interface Contract

The shell accepts:

| Input | Behavior |
|---|---|
| `activeDestination` | Marks Dashboard or Learn in the header |
| `activeDashboardView` | Marks Overview or All Packs in the Dashboard tablist |
| `searchQuery` | Displays current pack search state and submits to All Packs |
| `snapshotStatus` | Renders updated, delayed, or unavailable public status copy |
| `themePreference` | Resolves system-derived, explicit light, or explicit dark state |

Search submission navigates to All Packs with the normalized query. Search does not include Learn content in V1.

## Acceptance Criteria

### Navigation and Theme

- [x] Direct visits, links, and browser history work for all four approved route patterns.
- [x] Dashboard remains active on Overview and All Packs while the view tab identifies the exact surface.
- [x] Light and dark themes use the correct approved logo and expose identical content.
- [x] System preference initializes the first visit and an explicit choice persists locally.
- [x] Theme initialization does not flash the opposite theme.

### Utility and Boundary Behavior

- [x] Command/Control+K focuses search and does not hijack unrelated form input.
- [x] Search submission carries the query to All Packs without a command palette or suggestions.
- [x] The freshness region supports updated, delayed, and unavailable copy without layout movement.
- [x] No account, bookmark, notification, watchlist, or saved-view control appears.
- [x] Unknown routes use a not-found state rather than a generic runtime error.

## Build Status

- Implemented: the shared PackScout shell, exact route families, Dashboard tabs, catalog search, Command/Control+K behavior, stable freshness region, persisted system-aware theme, approved light/dark logos, disclaimer, responsive reflow, and not-found frame under `apps/frontend`.
- Verified: shell/theme/navigation tests, frontend lint/typecheck/build, boundary/framework checks, and browser review at 1536×1024, 1440×1000, and 390×844 in both themes; the final nonce fix removed console and hydration warnings.
- Status: done; all task-owned acceptance criteria and the verification anchor are satisfied.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: implemented the task-owned shell, route, search, theme, freshness, focus, not-found, and responsive foundations as specified entirely under `apps/frontend`.
- Divergences: none for task 004; Convex-backed status/preloads, nonce-based CSP hardening, and final route bodies remain owned by dependent tasks 003 and 005–012.
- Verification: frontend lint, typecheck, 11 tests, production build, boundary check, framework ratchet, and browser smoke at 1536×1024, 1440×1000, and 390×844 in both themes with no console or hydration errors.
