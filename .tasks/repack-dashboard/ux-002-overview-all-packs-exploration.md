# UX Spec: Overview and All Packs Exploration

**ID:** repack-dashboard/ux-002
**Related tasks:** repack-dashboard/002, repack-dashboard/003, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** repack-dashboard/ux-001
**Spec status:** draft

## Start Here

Open Dashboard Overview with the default active snapshot and confirm that four KPIs, six opportunities, two catalog summaries, and the first selection all reconcile with one applied filter state.

## Purpose

Help a buyer move from a fast market overview to systematic catalog comparison while preserving trustworthy metrics, accepted filters, and navigable query state.

## User Goals and Success Criteria

### Overview goals

- Understand current catalog scale and estimated-value distribution at a glance.
- Narrow the market with platform, category, and price filters.
- Inspect one of the six strongest current opportunities.
- Compare current platform and category composition without mistaking it for history.
- Carry accepted filters into All Packs.

### All Packs goals

- Search and compare the complete public catalog through twelve defined fields.
- Sort eligible metrics or use relevance-only ordering during search.
- Move through bounded cursor pages without losing accepted query state.
- Share or revisit a URL that restores search, filters, and metric sort.
- Select a pack without losing table position or opening its outbound listing.

## Current UX Context

### Confirmed

- The final comps establish a dense master-detail Overview with four KPIs, one filter strip, six opportunities, two current-catalog summaries, and a persistent inspector.
- The dark comp’s missing Highest Chase card is a comp-space inconsistency; V1 shows all four KPIs in both themes.
- All Packs owns the twelve-field comparison contract and uses a bottom preview to preserve table width.
- Filters have draft and accepted states. Apply commits; Reset immediately restores all platforms, all categories, and the full $10–$12,000 range.
- The full price state is a no-predicate state that retains packs without a canonical USD comparison price; narrowing either bound excludes them.

### Confirmed ordering

- Metric sort is unavailable while search is active; relevance is the only displayed order until search is cleared.

### Implementation guidance

- Use the comps’ visual density but remove decorative or unsupported data rather than shrinking it into illegibility.
- Keep Overview’s reduced opportunity columns distinct from All Packs’ complete table contract.
- Use one selection model across both views while letting each view own its placement.
- Treat current-catalog bars as labeled comparisons, never as charts over time.

## Information Architecture and Navigation

### Overview regions

1. Page title, Dashboard tabs, freshness, and disclaimer establish context.
2. Four KPI cards summarize the applied active-pack set.
3. One filter band owns draft Platform, Category, and Pack Price values.
4. Top Opportunities and platform/category summaries present the accepted results.
5. The selected inspector remains a sibling region governed by `ux-003`.

### All Packs regions

1. Page title and Dashboard tabs preserve the shared shell.
2. Search and the shared filter band expose accepted query state.
3. A twelve-column table owns comparison, sorting, row selection, and internal horizontal scrolling.
4. Result range and Previous/Next controls own cursor movement.
5. A selected bottom preview remains outside the table’s scroll region.

### Cross-view navigation

- `View all packs` carries accepted platform, category, and price filters to `/packs`.
- It does not carry the selected Overview pack.
- Search submission from Overview or Learn navigates to `/packs` and activates relevance order.
- Switching Dashboard tabs keeps compatible accepted filters.
- Browser history restores accepted All Packs query state from the URL.

## Interaction Model

### Apply and Reset

1. A user changes draft platform, category, or price values.
2. The controls indicate unapplied changes without changing results.
3. Apply submits all draft values as one request and prevents duplicate activation while pending.
4. Success replaces KPIs, rows, summaries, and eligible selection together.
5. Reset immediately restores default accepted filters and returns pagination to the first cursor page.

### Overview selection

1. Load the six EV $-ranked opportunities from the coherent Dashboard bundle.
2. Select the first visible opportunity when no valid selection exists.
3. A row activation updates the side inspector without moving results scroll position.
4. Applied filters preserve selection when the pack remains visible.
5. If it disappears, select the first visible opportunity or close the inspector when none remain.

### All Packs ordering

1. Without search, default to EV $ descending with stable public pack ID as the final tie break.
2. A sortable header toggles between its supported ascending and descending states.
3. Submitting non-empty search changes the visible order label to `Relevance`.
4. Metric sort controls become non-operative while relevance is active.
5. Clearing search restores the previously accepted metric sort or the default.

### Cursor pagination

- Show up to 25 rows on one cursor page; a valid page may contain fewer rows.
- Previous and Next are the only page commands and disable when their cursor is absent.
- Show the current visible result range and total only when the contract supplies it.
- Search, filter, or sort changes return to the first page.
- Preserve the selected row only while it remains on the visible page.

### Snapshot pagination reset

- When a newer snapshot activates, preserve valid filters and eligible selection but begin at its coherent first page.

### Facet and unavailable ordering

- Platform counts apply search, price, and Category selections while ignoring the Platform group itself.
- Category counts apply search, price, and Platform selections while ignoring the Category group itself.
- Keep accepted zero-count selections visible until Apply or Reset changes them.
- Place unavailable metric values after available values in both ascending and descending sorts.
- Explain price-unavailable exclusion when a narrowed price range produces no matches.

## Layout and Responsive Behavior

### Overview wide layout

- Place the four KPI cards in one balanced row above the filter band.
- Use a flexible results column and persistent inspector column, matching the final comp hierarchy.
- Keep Top Opportunities above the two summary regions.
- Let platform and category summaries share a row when each remains readable.
- Avoid wrapping every group in equal visual weight; KPIs and inspector are cards, while data regions use quieter boundaries.

### All Packs wide layout

- Give the comparison table primary width and place the preview below it.
- Keep all twelve columns; do not hide data to avoid horizontal scrolling.
- Make the table region horizontally scrollable while the page itself remains fixed to the viewport width.
- Keep the pack identity cell readable while scrolling; sticky behavior is optional only if it does not obscure focus or headers.
- Place pagination outside the horizontal scroll viewport.

### Narrow layout

- Reflow KPI cards into a readable grid without dropping Highest Chase.
- Stack filter groups and keep Apply and Reset adjacent to their owning controls.
- Replace the persistent Overview inspector and All Packs bottom preview with the shared modal sheet.
- Keep table horizontal scrolling inside its labelled region.
- Stack summary regions and preserve each bar’s label, count, and median value.

## States and Feedback

### Results states

- `loaded`: accepted query and results are visually synchronized.
- `applying`: accepted results remain visible while Apply shows local progress.
- `no_matches`: filters remain available, constraints are summarized, and Clear filters is primary.
- `empty_catalog`: no KPI or example values are invented and pack actions are omitted.
- `request_failed`: accepted results remain visible with a recoverable message near the initiating control.

### Field states

- Optional missing metrics display `Unavailable` with the approved public explanation.
- Missing category displays `Uncategorized` and remains filterable under that label when exposed as a facet.
- Sold-out rows remain in All Packs with visible status and disabled outbound action.
- Disabled packs are absent from both views.
- Unavailable-EV packs stay in All Packs but do not enter Overview Positive EV, Median EV, or Top Opportunities.

### Announcements

- Apply success announces the new result count and filter summary once.
- Sort changes announce the column and direction; search announces relevance order.
- Cursor changes announce the visible result range.
- Selection changes do not announce the entire inspector automatically.
- Failed replacement requests identify the retained accepted state.

## Accessibility

### Filters and summaries

- Use visible group labels and explicit selected-value summaries for multi-select controls.
- Associate price validation with the specific minimum or maximum input.
- Expose draft-versus-applied state without color alone.
- Give summary bars text equivalents containing group name, count, and median EV.
- Keep Apply and Reset keyboard reachable in logical order after their fields.

### Tables

- Use semantic tables, associated headers, and `aria-sort` only on supported sortable headers.
- Make rows selectable through a dedicated row action or clearly defined row interaction.
- Keep nested Promo and Pack Link controls independent from row selection.
- Provide enabled-by-default glossary hints by focus, activation, and pointer.
- Label the horizontal scroll region and make its overflow discoverable without hover.

## Visual Design Direction

### Overview

- Follow the final comps’ four concise KPI cards with distinct but restrained semantic icons.
- Use one violet selection treatment plus a non-color cue such as border weight or selection label.
- Align money and percentage values with tabular numerals.
- Use violet bars for catalog counts and text-based semantic color only for median EV.
- Keep `Current catalog` visible above each summary.

### All Packs

- Favor dense, quiet rows and fine separators over individually carded rows.
- Keep pack thumbnails compact and reserve their space to avoid shifts.
- Use compact status labels for sold-out and unavailable states.
- Keep action controls visually distinct from sortable data cells.
- Preserve the same table density in both themes rather than enlarging dark-mode spacing.

## Content and Microcopy

### Overview labels

- KPI labels: `Packs`, `Positive EV`, `Median EV`, `Highest Chase`
- Filter labels: `Platform`, `Category`, `Pack Price`
- Commands: `Apply`, `Reset`, `View all packs`
- Results heading: `Top opportunities`
- Summary labels: `By platform`, `By category`, `Current catalog`

### All Packs labels

- Table fields: `Platform`, `Category`, `Pack`, `Pack Price`, `EV $`, `EV %`
- Remaining fields: `Buyback %`, `Gross EV`, `Top Chase`, `Top Chase Value`, `Promo Code`, `Pack Link`
- Search order: `Relevance`
- Pagination: `Previous`, `Next`, `{start}–{end} of {total}` when total is available
- Empty command: `Clear filters`

## Design System and Component Notes

### Shared components

- `CatalogFilters`: draft values, accepted summary, Apply, Reset, and validation.
- `MetricPresentation`: signed EV $, signed EV %, Gross EV, semantic state, and unavailable copy.
- `PackIdentity`: thumbnail, name, category context, and sold-out label.
- `GlossaryHint`: keyboard/pointer definition surface with Learn links where relevant.
- `ResultStatus`: applying, no matches, failure, and retained-results feedback.

### View components

- `KpiGrid` and `KpiCard` for the four Overview outcomes.
- `OpportunityTable` for the fixed six-row ranked subset.
- `CatalogSummary` for platform/category count and median rows.
- `AllPacksTable` for the twelve-field comparison contract.
- `CursorPagination` for bounded Previous/Next navigation.

## Cross-Spec and Technical Dependencies

- `ux-001` owns shell, routes, global search, theme, and freshness placement.
- `ux-003` owns inspector content, nested actions, and narrow-screen sheet behavior.
- `ux-005` owns shared loading, delayed, empty, failure, responsive, and live-region behavior.
- Task `003` must return one coherent Overview result and stable application error outcomes without requiring the UX to interpret transport status.
- Convex search owns relevance; the UI must not offer metric sort or imply a secondary metric order during text search.

## QA and Review Checklist

### Overview

- [ ] Four KPIs, six opportunities, summaries, and selection reconcile with one accepted filter state.
- [ ] Both themes show all four KPI cards.
- [ ] Draft filters do not change results before Apply.
- [ ] Reset restores defaults in one action.
- [ ] Sold-out, disabled, and unavailable-EV packs do not enter Top Opportunities.

### All Packs

- [ ] All twelve fields remain available and pages contain up to 25 rows.
- [ ] Relevance is the only order while search is active.
- [ ] Metric sort, filters, and query restore from URL and browser history.
- [ ] Table overflow remains internal and nested actions do not select rows.
- [ ] Sold-out and unavailable-field rows remain understandable and present.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Intermediate widths can make filter controls and dense tables compete for horizontal space.
- Cursor pages can contain fewer than 25 rows, so copy must not imply fixed page size.
- Search relevance and restored metric sort can become visually ambiguous unless the current ordering mode is explicit.
- Reactive changes can invalidate selection between result and inspector updates.

## Handoff Notes

1. Build the accepted-versus-draft filter model before styling filter controls.
2. Prove Overview reconciliation and All Packs ordering with static contract examples.
3. Add selection while keeping nested actions isolated.
4. Add cursor and URL restoration after the query model is stable.
5. Finish with no-match, sold-out, unavailable, and failed-replacement reviews in both themes.
