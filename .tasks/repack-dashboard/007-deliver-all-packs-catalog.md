# Task: Deliver the All Packs Catalog

**ID:** repack-dashboard/007
**Depends on:** repack-dashboard/003, repack-dashboard/004, repack-dashboard/005
**Blocks:** repack-dashboard/008, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 5–8 days for one builder, including query-state and table verification
**Status:** blocked

## Start Here

Render one catalog cursor page of up to 25 rows with all twelve comparison fields, then restore that exact search, filter, sort, and page state from its URL.

## Objective

Let buyers search and systematically compare the full public pack catalog with trustworthy sorting, filtering, pagination, and field explanations.

## Context

Overview intentionally shows a reduced ranked table. All Packs owns the complete twelve-field comparison contract from the original V1 plan. It uses the same app shell, metric vocabulary, active snapshot, and applied filter model.

## Requirements

### Search and Filters

- Search pack name, platform display name, and category from the global or in-page search field.
- Submit search explicitly and normalize surrounding whitespace; an empty search restores metric sorting.
- Provide the same multi-select Platform, multi-select Category, and $10–$12,000 price controls as Overview.
- Apply draft filters once and make Reset immediately restore the complete catalog query.
- Keep accepted search and filter state in the URL for refresh, sharing, and browser history.

### Price State

- Treat the default full price state as no price predicate; an explicitly narrowed range excludes rows whose canonical USD comparison price is unavailable.

### Table Fields

- Show Platform, Category, Pack, Pack Price, EV $, EV %, Buyback %, Gross EV, Top Chase, Top Chase Value, Promo Code, and Pack Link.
- Keep Pack name, image, and sold-out status together without adding a thirteenth column.
- Show unavailable values explicitly and retain rows whose optional metrics are unavailable.
- Provide every header’s glossary hint by pointer and keyboard.
- Keep pack rows selectable independently from promo and outbound link controls.

### Sorting

- Default to EV $ high to low when no text query is present.
- Support ascending and descending Pack, Pack Price, EV $, EV %, Buyback %, Gross EV, and Top Chase Value sorts.
- Use stable public pack ID as the final tie break.
- Place unavailable metric values last in both ascending and descending sorts.

### Search Ordering

- Replace metric sorting with Relevance while text search is active.
- Restore the prior accepted metric sort when search is cleared.

### Pagination and Selection

- Return up to 25 rows per cursor page with Previous, Next, and visible result-range feedback.
- Disable Previous or Next when no page exists in that direction.
- Reset pagination to the first page after search, filter, or sort changes.
- Preserve the current selected row when it remains visible; otherwise select the first visible row.
- Open the selected-pack preview without navigating away from catalog state.

### Availability and Actions

- Include active and sold-out public packs; exclude disabled packs.
- Label sold-out packs and disable their Pack Link action.
- Show Copy Promo only when a public code exists.
- Show Pack Link only when an approved listing URL exists.
- Keep action cells unavailable rather than rendering placeholder links or codes.

## User-Facing Behavior

Users can share or revisit an exact catalog view, compare a bounded cursor page, understand every column, and select a row for detail without losing table position. Search prioritizes relevance; clearing it returns the prior metric sort.

## Interface Contract

All Packs consumes `CatalogPage` and emits one serialized `CatalogQueryState`:

| State group | Fields |
|---|---|
| Search | normalized text query |
| Facets | platform keys, category keys, minimum and maximum price |
| Order | approved sort key, direction, or relevance |
| Page | opaque cursor and direction |
| Selection | public pack ID kept outside the shareable filter query |

The table passes selected `PackSummary` data to `repack-dashboard/008`; actions use the public configuration published by `repack-dashboard/002`.

## Acceptance Criteria

### Catalog Behavior

- [x] A default request shows up to 25 rows, twelve fields, EV $ descending order, and correct page controls.
- [x] Combined search, multi-select facets, price range, and sorting return only matching public packs.
- [x] Search uses relevance and clearing restores the prior metric sort.
- [x] Refresh and browser history restore accepted catalog state.
- [x] Changing search, filters, or sort returns to the first page.

### Rows, Actions, and Boundaries

- [x] Missing optional metrics remain visible as unavailable rather than dropping the row.
- [x] Sold-out rows are labeled and non-actionable; disabled rows are absent.
- [x] Promo and Pack Link controls appear only with approved data.
- [ ] Row selection does not trigger when a nested action is activated.
- [x] The table scrolls inside its own region without page-level horizontal overflow.

## Build Status

- Implemented: canonical URL-backed search/facets/price/sort/cursor state, the exact twelve-column All Packs table, relevance mode, unavailable-last sort affordances, result range/pagination, selected bottom preview, and narrow-screen inspector sheet under `apps/frontend`. The page consumes Convex list results with a bounded detail array aligned one-to-one to the current rows; all 9 seeded packs, including the sold-out record, remain discoverable.
- Verified: public read-model/seed tests cover filtering, relevance, contextual facets, sorting, price semantics, cursors, and row/detail coherence; frontend tests cover exact columns, sort state, sold-out actions, URL normalization/history state, and first-page resets. Desktop/mobile browser QA covers search, row selection, inspector updates, and owned table overflow against the local Convex backend; cloud-development browser smoke confirms search, row selection, and inspector updates through the HTTPS `abundant-puffin-373` read path.
- Blocked: task `003` has no activated/reactive canonical cloud snapshot. The live cursor/history flow and reactive replacement still require recorded end-to-end evidence against the canonical cloud read model.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-005
- Alignment: the catalog implements the specified twelve fields, explicit search submission, URL-restorable state, relevance-only search order, bounded cursor navigation, optional-value retention, sold-out behavior, and owned horizontal overflow.
- Divergences: initial/replacement reads use the non-reactive Convex route boundary from task `003`; live `usePreloadedQuery` replacement and cloud-backed cursor continuity remain open.
- Verification: contracts/Convex query and seed tests, All Packs/query-state tests, frontend typecheck/lint/build, desktop/mobile local search/selection/overflow/inspector review, and cloud-development search/selection smoke recorded green.
