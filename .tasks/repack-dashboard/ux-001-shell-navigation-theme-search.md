# UX Spec: Shell, Navigation, Theme, and Search

**ID:** repack-dashboard/ux-001
**Related tasks:** repack-dashboard/002, repack-dashboard/003, repack-dashboard/004, repack-dashboard/007, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** none
**Spec status:** draft

## Start Here

Open `/` at 1440×1000 in light theme and establish the shared header first: approved PackScout logo, catalog search, Dashboard/Learn navigation, snapshot status, and theme control.

## Purpose

Give an anonymous buyer a stable PackScout frame for navigating, searching, checking freshness, and choosing a theme without losing route or query context.

## User Goals and Success Criteria

### Primary goals

- Recognize PackScout and the current destination immediately.
- Move among Overview, All Packs, Learn, and articles through real URLs.
- Submit a pack search from any public route and arrive at matching All Packs results.
- Understand whether the public catalog is updated, delayed, or unavailable.
- Use the same complete feature set in light and dark themes.

### Success signals

- Browser back, forward, refresh, and direct links restore the expected surface.
- Command/Control+K focuses search without opening another interface.
- An explicit theme choice persists on that device without requiring an account.
- Header content does not shift when freshness copy changes.
- Narrow layouts reflow without page-level horizontal overflow.

## Current UX Context

### Confirmed

- The current frontend is a one-page “Basecamp” placeholder with a forest, paper, and orange field-note aesthetic; its product copy and visual identity are replaced.
- The hashed `final-dashboard-v1-light.png` and `final-dashboard-v1-dark.png` files named by `docs/design-comps/packscout-frontend/FINAL-REFERENCE.md` govern hierarchy, density, theme parity, violet accent, near-white light surfaces, and deep navy-black dark surfaces.
- Dashboard and Learn are the only global product destinations. Overview and All Packs are parallel Dashboard views.
- V1 is anonymous and has no account, bookmark, watchlist, notification, saved-view, or command-palette control.
- Search covers pack name, platform display name, and category; it does not cover Learn content.

### Implementation guidance

- Preserve the comps’ compact app-header character while allowing utilities to wrap into intentional rows before they collide.
- Treat the header as persistent structure, not as a decorative card.
- Keep controls visually quiet until focused, active, delayed, or unavailable.
- Use the approved horizontal logo asset for each theme rather than recreating or recoloring the mark.

## Information Architecture and Navigation

### Route map

| Route | Destination | Active state |
|---|---|---|
| `/` | Dashboard Overview | Dashboard + Overview |
| `/packs` | Dashboard All Packs | Dashboard + All Packs |
| `/learn` | Learn index | Learn |
| `/learn/:slug` | Learn article | Learn |

### Navigation hierarchy

1. Global header identifies PackScout and exposes Dashboard and Learn as links.
2. Dashboard pages expose Overview and All Packs as a tablist below the page title.
3. Search submission navigates to `/packs` with the normalized query.
4. Learn articles retain the global header and provide an in-content return to `/learn`.
5. Unknown routes and article slugs use the shared not-found outcome.

### Active-state behavior

- Dashboard remains globally active on both `/` and `/packs`.
- The Dashboard tablist identifies the exact current view.
- Learn remains active throughout the index and article routes.
- Active styling uses weight, position, and an indicator in addition to violet color.
- Destination labels remain visible; do not replace them with icon-only navigation.

## Interaction Model

### Catalog search

1. A pointer or keyboard user focuses the single labeled search field.
2. Command/Control+K focuses that field unless focus is already inside an editable control.
3. Submit trims surrounding whitespace and navigates to All Packs.
4. A non-empty query activates relevance-only ordering until search is cleared.
5. Clearing search restores the last accepted metric sort or the EV $ default.

### Theme control

1. On a first visit, resolve light or dark from the operating-system preference.
2. Show the resolved state through a labeled two-state control with a visible selected state.
3. Persist an explicit choice locally on the device.
4. Apply the choice before first paint when possible and update browser theme metadata.
5. Keep all content, four Overview KPIs, states, and actions identical across themes.

### Freshness status

- Fresh shows a green status indicator and `Updated {relative time}` when the active complete snapshot has a successful catalog observation no more than 15 minutes old and no delayed input.
- Delayed shows an amber indicator and `Some data delayed` with the last successful observation time when an input is delayed or observation age exceeds 15 minutes.
- Initial unavailability uses a neutral unavailable status and defers the recovery action to page content.
- Expose an exact timestamp in the accessible name or supplementary text.
- Do not reveal provider names, internal failures, tenant identifiers, or recovery instructions.

## Layout and Responsive Behavior

### Wide workspace

- Keep logo, search, centered primary navigation, freshness, and theme control in one compact header row when space permits.
- Place the Dashboard title and view tabs at the start of the content canvas; align the disclaimer to the opposite edge.
- Use a centered fluid canvas that supports the dense 1440×1000 review viewport.
- Reserve stable inline space for each header utility to avoid data-refresh movement.

### Narrow workspace

- Keep logo, primary destination, and theme access in the first usable header row.
- Move search to a full-width row when needed; do not shrink its label or hit target beyond usability.
- Place freshness on its own readable line when it no longer fits beside theme controls.
- Keep Overview and All Packs tabs horizontally visible without requiring page scrolling.
- Stack title and disclaimer while preserving their reading order.

## States and Feedback

### Header states

- `ready`: all navigation and utilities are operable.
- `loading`: navigation, search, theme, and Learn remain operable while freshness reserves its final geometry.
- `delayed`: last successful observation time remains visible with amber semantics while the last complete snapshot stays usable.
- `snapshot_unavailable`: navigation and Learn remain operable; Dashboard content owns Retry.
- `not_found`: shell remains intact around concise not-found content.

### Search feedback

- Submitting search provides immediate local progress without clearing the accepted page.
- A failed replacement request retains the previous accepted results and query.
- Result counts are announced on All Packs, not inside the global header.
- Empty submitted text behaves as clear-search, not as an error.

## Accessibility

- Give the logo link an accessible PackScout home name and mark decorative logo details hidden.
- Expose current global navigation with `aria-current`; expose Dashboard views with tab semantics.
- Associate a persistent visible label with search; the placeholder is supporting copy only.
- Give the theme control an accessible name that states the resulting theme.
- Use a polite status region for freshness changes without announcing every relative-time tick.

### Keyboard expectations

1. Tab order follows logo, global navigation, search, freshness details when interactive, theme, then page controls.
2. Command/Control+K focuses search and does not type the shortcut character.
3. Enter submits search; Escape dismisses only transient search feedback.
4. Focus indicators remain visible against both theme surfaces.
5. Route changes place focus at the new page heading unless browser-history restoration preserves a meaningful control.

## Visual Design Direction

### Confirmed

- Use the final comps’ violet gradient for primary actions and active navigation.
- Use fine borders, restrained radii, compact controls, and high-clarity type rather than the placeholder’s field-note styling.
- Use near-white layers in light mode and deep navy-black layers in dark mode.
- Keep green, amber, and red for semantic status rather than general decoration.
- Preserve generous clear space around the approved logo.

### Implementation guidance

- Prefer one quiet header boundary over multiple stacked card containers.
- Use tabular numerals for update times.
- Keep icons secondary to text labels and accessible names.
- Avoid animated theme flourishes; a short transition may be used only when reduced motion allows it.

## Content and Microcopy

### Header copy

- Search label: `Search packs`
- Search placeholder: `Search packs, platforms, categories…`
- Primary links: `Dashboard`, `Learn`
- Dashboard tabs: `Overview`, `All Packs`
- Disclaimer: `Estimated EV · Not financial advice.`

### Boundary copy

- Fresh: `Updated {relative time}`
- Delayed: `Some data delayed · Updated {time}`
- Unavailable status: `Pack data unavailable`
- Unknown route heading: `Page not found`
- Unknown article action: `Back to Learn`

## Design System and Component Notes

### Shared patterns

- `AppShell`: logo, navigation, utilities, content landmarks, and route focus behavior.
- `CatalogSearch`: visible label, shortcut hint, submit behavior, and progress state.
- `DashboardViewTabs`: route-backed Overview and All Packs tabs.
- `SnapshotStatus`: fresh, delayed, and unavailable variants with stable width.
- `ThemeControl`: system-derived initialization and explicit local choice.

### Token direction

- Replace placeholder canvas, pine, moss, trail, display-serif, and field shadow tokens with semantic app tokens.
- Define canvas, raised surface, text, muted text, border, violet action, focus, and metric-state tokens for both themes.
- Keep stable layout styles in shared classes or utilities, not repeated inline objects.
- Reuse the same token meanings across Dashboard and Learn.

## Cross-Spec and Technical Dependencies

- `repack-dashboard/ux-002` consumes the view tabs and shared search/query context.
- `repack-dashboard/ux-004` consumes the same shell for Learn routes.
- `repack-dashboard/ux-005` owns loading, delayed, not-found, responsive, and announcement details shared by the shell.
- Task `002` supplies sanitized snapshot status, immutable completion time, and last-successful-observation time; task `003` supplies accepted query behavior.
- Theme initialization must respect Next.js server/client boundaries and avoid reading server-only data from browser components.

## QA and Review Checklist

### Navigation and search

- [ ] Every approved route works through direct visit, links, refresh, back, and forward.
- [ ] Dashboard and exact view active states are simultaneously correct.
- [ ] Search submits to All Packs and relevance remains the only order while active.
- [ ] Command/Control+K focuses search without hijacking another input.
- [ ] Unknown routes and article slugs retain the shell and show not-found content.

### Theme and status

- [ ] System theme initializes the first visit and explicit choice persists locally.
- [ ] No opposite-theme flash, content mismatch, or logo mismatch is visible.
- [ ] Four Overview KPIs remain present in both themes.
- [ ] Fresh, delayed, and unavailable status copy does not move adjacent controls.
- [ ] No out-of-scope account or personalization control appears.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Theme initialization can produce hydration or flash defects if server and browser resolution disagree.
- The dense desktop header can collide at intermediate widths without deliberate wrapping rules.
- A relative freshness timer can become noisy for assistive technology if every tick is announced.

## Handoff Notes

1. Build the shell and route active states before styling page-specific data regions.
2. Verify search-to-All-Packs navigation before adding keyboard shortcut behavior.
3. Add theme initialization and exact browser metadata after the static theme tokens exist.
4. Connect freshness only to completed public snapshot metadata.
5. Review the exact comps at 1536×1024 plus 1440×1000 and 390×844 responsive behavior in both themes before dependent surfaces are stable.
