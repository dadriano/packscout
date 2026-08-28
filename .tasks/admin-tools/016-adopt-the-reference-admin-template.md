# Task: Adopt the Reference Admin Template

**ID:** admin-tools/016
**Depends on:** none
**Blocks:** none
**Estimated scope:** medium
**Status:** done

## Objective

The PackScout admin wears the approved reference admin's visual template — its typography, palette, token architecture, and layout patterns — so operators get one familiar console across both systems and new admin features can transplant reference page structures with minimal restyling.

## Context

The PackScout admin's behavior already follows the approved reference admin (login/session model, guard patterns, and — via this feature — its user-administration flows), but its visual identity is homegrown: serif display type, a dark-green sidebar, and a small custom token vocabulary. The reference admin's template is a different, more complete system: warm neutral operational surfaces on the Inter type family, a blue primary, a comprehensive CSS custom-property vocabulary covering text/border/surface/input/status families, a sidebar of titled navigation sections with breadcrumbs, and theme support.

Adopting the reference template is a deliberate simplification: the product-user pages this feature adds (admin-tools/003–005) have direct counterparts in the reference admin, and matching templates means those and future ports are near-copies instead of redesigns. This task is visual-only — no route, permission, flow, or copy-semantics changes. The admin's existing foundation (shared layout, dialog, toast, confirmation, status, empty-state components and token-driven styling) is evolved in place, never forked, consistent with the repository's admin baseline rules.

## Requirements

- Replace the admin's CSS token system with the reference template's token architecture and values — typography (sans and mono stacks), background/surface/elevation neutrals, text hierarchy, border weights, input styling, and the primary/success/warning/danger status families — keeping tokens the single source of styling truth.
- Restyle the shell and every shared component to the reference look: sidebar navigation with titled sections, top bar, page headers, dialogs and confirmations, toasts, status badges, tables/ledgers, forms and field validation states, pagination controls, and empty states.
- Preserve the admin's existing capabilities while restyling: responsive behavior including the narrow-viewport navigation drawer, the light/dark theme toggle (both themes expressed through the reference token architecture, with the reference's light appearance as the canonical rendering), and accessibility — keyboard operability, focus visibility, labelling, and contrast at least at the current level.
- Every existing admin page renders on the new template; the old token vocabulary is removed entirely so no page or future feature can straddle two systems.
- No behavioral changes: routes, permission gating, flows, request/response contracts, and page semantics are untouched; the diff is presentational. Existing tests keep passing, with only presentation-specific assertions updated.
- Update the canonical UI documentation wherever it encodes the old visual identity, so the adopted template is the documented standard new features are checked against.

## User-Facing Behavior

An operator signs in and finds every page where it was, doing what it did, but rendered in the reference template: warm neutral surfaces, Inter typography, titled sidebar sections, and consistent status colors. The theme toggle still switches light and dark. Nothing moves, nothing gains or loses a capability — the console simply looks like the reference admin.

## Interface Contract

- The reference-derived token vocabulary and the restyled shared components become the extension surface that admin-tools/003, 004, 005, 007, and 008 build their pages on — those tasks inherit the template automatically by following the existing rule of extending the shell rather than inventing local styles.
- The template is the visual parity reference for future ports: a page that exists in the reference admin should be reproducible here by mapping its structure onto these tokens and components.

## Acceptance Criteria

- [x] All existing admin pages render on the reference template with no remaining use of the old palette, typography, or token names.
- [x] Light and dark themes both express the reference template through the shared token architecture, and the toggle works as before.
- [x] Keyboard operability, focus visibility, labelling, and contrast are preserved across the shell, dialogs, forms, and ledgers at desktop and narrow widths, including the navigation drawer.
- [x] The full admin test suite passes with only presentational assertions changed; no route, permission, or flow behavior differs.
- [x] Canonical UI documentation reflects the adopted template.

## Verification

The admin lint, typecheck, test, and build commands exit 0 after the restyle, and desktop plus narrow-width browser smoke passes over the shell, one ledger page, one form page, and one dialog flow show the template applied with no page-level overflow or inaccessible controls.

## Spec Compliance

- Related specs reviewed: none
- Alignment: The admin now renders entirely on the reference template's token architecture and values — Inter type family, warm neutral surfaces, blue primary, and the full text/border/input/status token families — with the shell, ledgers, forms, dialogs, toasts, badges, pagination, and empty states restyled in place rather than forked.
- Divergences:
  - Focus indication keeps a 3px `--admin-primary` outline instead of the reference's soft inset ring, because the acceptance criteria require focus visibility at least at the previous level.
  - Small uppercase labels use `--admin-text-muted` rather than `--admin-text-faint`, and dark-theme primary buttons use a dark ink token, both to hold contrast at or above the previous level. Two border tokens (`--admin-success-border`, `--admin-warning-border`) were added so banner borders stay token-driven instead of hardcoded.
  - Breadcrumbs were not added. They belong to the reference shell but are a navigation affordance rather than a restyle, and this task is scoped to a presentation-only diff.
  - Provider styling moved out of `index.css` into `src/data-providers.css`, matching the existing per-feature stylesheet convention (`operations.css`, `alerts.css`).
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin && npm run check:docs` exits 0 (69/69 admin tests pass, with no test assertion changed); `npm run scan:framework-standards:ratchet` reports 0 new findings. A token audit confirms every custom property used across the four stylesheets is declared in `theme.css` and that no old token name survives anywhere in `apps/admin`. Browser smoke against the built SPA at 1280px and 375px covered the shell, the overview, the providers ledger, the operators ledger with its filter form, the create-operator dialog, a destructive confirmation, an error toast, the sign-in page, and the not-found page: `document.documentElement.scrollWidth === clientWidth` at both widths, the narrow-viewport drawer opens over a dimmed backdrop and closes, the theme toggle flips light and dark and persists, and keyboard Tab reaches nav links with a visible 3px primary focus ring.
