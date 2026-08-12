# Task: Complete Responsive and Accessible Behavior

**ID:** repack-dashboard/011
**Depends on:** repack-dashboard/004, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/010
**Blocks:** repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 3–5 days for one builder, including keyboard and browser smoke verification
**Status:** blocked

## Start Here

Complete the full Overview select-and-inspect flow at 390×844 using only the keyboard, then repeat it at 1440×1000 in both themes.

## Objective

Make the complete Dashboard and Learn experience readable and operable across supported widths, input methods, themes, and motion preferences.

## Context

The final comps are desktop-dense. Repository standards require mobile usability, internal table scrolling, no page-level horizontal overflow, visible focus, accessible dynamic updates, readable contrast, and reduced-motion behavior.

## Requirements

### Responsive Layout

- At wide desktop widths, keep Overview as a results-and-inspector workspace matching the supplied comp hierarchy.
- Keep All Packs wide enough for twelve columns by scrolling the table region rather than the page.
- At narrow widths, stack the shell and filters, keep primary actions reachable, and open selected detail in a modal sheet.
- Reflow four KPI cards without hiding Highest Chase in dark mode.
- Prevent text collision, clipped controls, and page-level horizontal overflow at 390×844 and 1440×1000.

### Keyboard and Focus

- Reach every link, field, filter, tab, sortable header, row, tooltip, promo control, Pack Link, theme control, and sheet action in logical order.
- Give every interactive element a visible focus indicator in both themes.
- Move focus into an opened modal sheet, contain it while open, and restore it to the selected row on close.
- Keep row selection independent from nested action controls.
- Support Escape for dismissible tooltip and sheet interactions.

### Semantics and Announcements

- Use table semantics, header associations, and `aria-sort` for sortable catalog columns.
- Give icon-only controls an accessible name and explanatory tooltip when their meaning is not universal.
- Announce results, pagination, clipboard outcomes, loading completion, and recoverable errors without excessive repetition.
- Express EV state through text/sign plus color and expose summary-bar values as text.
- Give tabs, dialogs, status regions, and search their expected semantic roles.

### Visual Access

- Meet readable text, focus, border, semantic-state, and control contrast in light and dark themes.
- Keep text usable under browser zoom and increased text size.
- Reserve image space to avoid layout shifts and retain useful alt text or decorative treatment.
- Disable nonessential animation under reduced motion.
- Preserve meaning without hover, imagery, color, or motion.

### Browser Verification

- Exercise Overview, All Packs, inspector, promo copy, Pack Link, theme, and Learn navigation in a real browser.
- Check 1440×1000 and 390×844 in light and dark themes.
- Compare both themes against the versioned 1536×1024 final comps at their native viewport.

### Browser Evidence

- Verify no console error, hydration warning, broken image loop, or page-level overflow occurs.
- Record keyboard, focus, screen-reader-semantic, zoom, and reduced-motion evidence.
- Record any automation gap with an owner and follow-up rather than hiding it.

## User-Facing Behavior

Users can complete every V1 flow by keyboard, pointer, or touch. The layout remains stable and understandable across themes and supported widths, including when images or metrics are unavailable.

## Interface Contract

This task does not create a new data contract. It verifies that the shell and tasks `006`–`010` expose stable labels, roles, focus targets, live feedback, and responsive regions. Any control that cannot meet this contract returns to its owning task for correction before completion.

## Acceptance Criteria

### Accessibility Evidence

- [ ] Every V1 interaction completes by keyboard with visible focus and logical order.
- [x] Sort, tab, tooltip, sheet, status, and table semantics expose the same meaning as the visual UI.
- [x] Focus enters and exits the narrow-screen inspector correctly.
- [x] EV state and summary values remain understandable without color or charts.
- [ ] Both themes meet the project contrast and reduced-motion requirements.

### Responsive Browser Evidence

- [x] Overview and All Packs have no page-level horizontal overflow at both required viewports.
- [x] The twelve-column table scrolls only inside its owned region.
- [x] Four KPI cards, filters, actions, and Learn content remain readable at 390×844.
- [x] Both theme/view combinations complete without console errors, hydration warnings, or broken layouts.
- [x] Browser evidence records viewport, theme, flow, and any explicit automation gap.

## Build Status

- Implemented: responsive shell, filters, four-KPI grid, internal table overflow, side/bottom-to-modal inspector placement, semantic metrics/tables/tabs/status/glossary controls, focus trap/return, Escape handling, and reduced-motion-aware styling.
- Verified: real-browser review at 1440×1000 and 390×844 against the local Convex seed confirms visible Mock data labeling, search and noninitial-row selection, no page-level overflow, owned table scrolling, readable KPIs/filters/actions/Learn, modal focus entry/containment/Escape/return, and zero console or hydration warnings.
- Blocked: dependencies `006`–`010` remain blocked. A complete keyboard-only run of every V1 action plus recorded automated contrast, 200% zoom/increased-text, and reduced-motion evidence is still required before this task can be done.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: the implemented layouts and semantics follow the required desktop master-detail, mobile sheet, internal-table-overflow, visible text/sign meaning, theme parity, and focus lifecycle.
- Divergences: Browser inspection supplied local Convex-backed evidence, but the specified full Playwright artifact matrix and complete keyboard/zoom/contrast/reduced-motion audit do not yet exist.
- Verification: frontend tests/typecheck/lint/build plus browser checks at the two responsive viewports recorded green for the checked criteria; explicit remaining gaps are listed above.
