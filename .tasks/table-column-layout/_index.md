# Feature: Table column layout

Status: implemented directly on the All Repacks table (no phased build)
Owner: All Repacks table

## Context

The All Repacks table shows fifteen comparison columns. Viewers compare repacks on different fields, so they need to hide what they do not use and order what they do. The layout is personal: a signed-out visitor keeps it for the current browser tab, and a signed-in viewer keeps it on the account across devices.

## Resolved decisions

- The control lives in the table heading (`Columns`). It opens a small non-modal panel with every column in its current order: a checkbox to show or hide, a drag handle, and up/down moves for touch and keyboard.
- The **Repack** column is the row identity; it can be reordered but never hidden.
- Changes apply immediately. There is no separate save step; **Reset** restores the default and removes the stored layout.
- Signed-out: the layout is kept in `sessionStorage` under `packscout.table-columns.<table>` and is gone when the tab closes. The panel says so and offers **Sign in to keep it**.
- Signed-in: the layout is stored on the account in Convex (`tableColumnLayouts`, owner-scoped by the verified token identifier the capability gate returns, upserted per table key). Reads and writes never accept an owner from the browser, and every entry point passes through `requireAdmittedProductUser` like saved items do.
- A held closed-beta account gets its account read refused by the gate; the frontend absorbs that with the tolerant query hook and keeps that viewer on the tab-scoped layout (no sign-in prompt, since they are signed in).
- The first time a viewer signs in without an account layout, the tab layout is adopted into the account and removed from the tab.
- Stored layouts are reconciled against the live column list: unknown keys are dropped, required columns are forced visible, and columns added later slot in after their default neighbour, visible.
- Table keys and column-key rules live in `@packscout/contracts` (`TABLE_COLUMN_LAYOUT_TABLE_KEYS`) so other tables can adopt the same store by registering a key.

## Out of scope

- Column widths, pinning, or freezing
- Layouts on the Overview opportunity table
- Sharing layouts between accounts or admin inspection of a viewer's layout
- Preserving a signed-out layout across browser restarts

## Verification

| Behavior | Coverage |
|---|---|
| Layout reconciliation, moves, visibility, storage parsing, session store | `apps/frontend/lib/table-column-layout.test.ts` |
| Header ordering and the required column | `apps/frontend/lib/all-repacks-table.test.ts` |
| Trigger, persistence copy, announcements, drop index | `apps/frontend/components/catalog/column-layout-presentation.test.ts` |
| Table renders headers and every row from the layout; identity column stays visible | `apps/frontend/components/catalog/AllRepacksTable.test.tsx` (server render) and `apps/frontend/components/catalog/AllRepacksTable.source.test.ts` |
| Every auth provider mounts a store; account reads gated on sign-in | `apps/frontend/components/table-layout/table-column-layout-wiring.source.test.ts` |
| Contract vocabulary and entry validation | `packages/contracts/src/table-column-layout.test.ts` |
| Owner-only Convex reads/writes, closed-beta refusal, isolation, upsert, clear, fail-closed validation | `convex/tableColumnLayouts.test.ts` (plus main's gate enumeration test, which scans this module) |
| Popover open/close, drag reorder, keyboard reorder, responsive heading | Browser smoke pass (recorded in the handoff) |
