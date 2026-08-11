# Task: Deliver the Dashboard Overview

**ID:** repack-dashboard/006
**Depends on:** repack-dashboard/003, repack-dashboard/004, repack-dashboard/005
**Blocks:** repack-dashboard/008, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including interaction and aggregate verification
**Status:** blocked

## Start Here

Render the four KPI cards from one Dashboard bundle, then verify their values reconcile with the same bundle’s opportunities and summaries.

## Objective

Give buyers a current, filterable market overview that surfaces the strongest opportunities, catalog scale, and platform/category distribution before they open the full table.

## Context

The final comps use a dense desktop master-detail layout: four KPIs, one filter strip, six ranked opportunities, platform/category summaries, and a selected-pack inspector. Light and dark themes expose the same data even though the source dark comp omitted the fourth KPI for space.

Overview is not a historical-trend screen. All bars and summaries represent the active current snapshot after applied filters.

## Requirements

### KPI Cards

- Show Packs, Positive EV, Median EV, and Highest Chase in both themes.
- Count active public packs after applied filters for Packs.
- Keep the visible label `Packs` and expose helper text or an accessible description stating that it counts active public packs matching the applied filters.
- Count active packs with signed EV % above zero for Positive EV.

### KPI Value Outcomes

- Compute Median EV from estimated active packs only; show unavailable when none have an estimate.
- Compute Highest Chase from eligible active-pack chase values; show unavailable when none exist.

### Filters

- Provide multi-select Platform and Category controls plus a $10–$12,000 price range.
- Keep draft changes local until Apply is activated.
- Apply filters to KPI cards, opportunities, summaries, and inspector selection as one state change.
- Reset immediately restores all platforms, all categories, and the full price range.
- “View all packs” carries the applied filters to All Packs.

### Top Opportunities

- Rank the six highest active estimated packs by EV $ high to low with deterministic ties.
- Show rank, Pack, Platform, Category, Pack Price, EV %, Buyback %, and Top Chase Value.
- Pair Pack with its deterministic primary thumbnail and Platform with its approved logo or text fallback, matching the final comps without adding comparison columns.

### Opportunity Selection

- Keep the selected row visibly distinct without relying on color alone.
- Select the first visible opportunity when the current selection is absent.
- Exclude sold-out, disabled, and unavailable-EV packs from the ranking.

### Catalog Summaries

- Show at most five platforms and five categories ordered by filtered pack count.
- Display pack count and median signed EV % for each group.
- Exclude unavailable estimates from group medians without excluding their packs from counts.
- Scale bars to the largest visible count and pair every bar with its numeric value.
- Label summaries “Current catalog” so bars are not interpreted as trends.

## User-Facing Behavior

Users adjust draft filters, apply once, inspect the resulting market summary, select an opportunity, or continue to All Packs with the same filters. Reset provides a one-step return to the complete overview.

## Interface Contract

Overview consumes one `DashboardBundle` containing applied filters, snapshot metadata, four KPI outcomes, six opportunity summaries, platform/category summaries, and selected-pack detail. Every aggregate includes its unavailable state and display currency.

Filter submission emits the normalized public query state. “View all packs” serializes that same accepted state without carrying a selected-row ID.

## Acceptance Criteria

### Overview Evidence

- [x] Both themes show the same four KPI values and labels.
- [x] Six opportunities use EV $ descending order and deterministic ties.
- [x] Platform and category summaries reconcile with the filtered active pack count.
- [x] Unavailable estimates affect pack counts but not EV medians or positive counts.
- [x] Sold-out and disabled packs never enter Top Opportunities.

### Interaction Evidence

- [ ] Draft filters do not alter results before Apply.
- [ ] Apply updates every Overview region coherently.
- [ ] Reset restores all default filters and results in one action.
- [x] Selection falls back to the first visible opportunity when filtering removes it.
- [x] View All Packs preserves applied platform, category, and price filters.

## Build Status

- Implemented: the comp-aligned four-KPI Overview, filter band, six-row opportunity table, two current-catalog summaries, deterministic local selection, and responsive side/sheet inspector, all under `apps/frontend`.
- Verified: Convex query tests prove coherent active-only aggregation/ranking; presentation tests prove four KPIs, provider order, selection fallback, and summary scaling; browser review confirms matched light/dark content and the desktop/mobile hierarchy.
- Blocked: tasks `003` and `005` remain blocked. The route has no activated/reactive cloud snapshot, and draft/Apply/Reset end-to-end interaction has not been recorded against that live coherent data source.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-005
- Alignment: the local Overview follows the specified one-bundle hierarchy, four KPI parity, EV-dollar-ranked opportunities, current-catalog summaries, filter serialization, and side-to-sheet responsive placement.
- Divergences: local fixture mode is explicit and non-production; the route currently uses the non-reactive server read boundary documented in task `003`, so live Apply/replacement and snapshot-reactivity acceptance remains open.
- Verification: Convex/read-contract tests, Overview presentation tests, frontend typecheck/lint/build, and 1440×1000/390×844 browser review in light and dark recorded green for the implemented slice.
