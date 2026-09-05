# Feature: Table column layout

Status: implemented
Owner: table-column-layout

## Scenario: A viewer hides and reorders All Repacks columns from the table

Given a viewer is on All Repacks with the default fifteen columns
When they open Columns, uncheck Category, and move EV % above Repack Price
Then the table immediately shows fourteen columns in the new order
And the Columns control reads "1 hidden"
And Repack cannot be unchecked because it identifies the row

Coverage: Automated — `apps/frontend/lib/table-column-layout.test.ts`, `apps/frontend/components/catalog/column-layout-presentation.test.ts`, `apps/frontend/components/catalog/AllRepacksTable.test.tsx`, `apps/frontend/components/catalog/AllRepacksTable.source.test.ts`; Manual gap — the test lanes run no DOM, so the panel (checkbox, arrow-button, arrow-key, and `DragEvent` reorder paths, Escape and focus return) is covered by the recorded browser smoke pass; a native pointer drag still needs a hands-on check because CDP synthetic drags do not start HTML5 drag-and-drop

## Scenario: A signed-out viewer keeps the layout for the tab only

Given a signed-out viewer has customized the columns
When they reload the page in the same tab
Then the customized layout is restored from session storage
And the panel says the layout is kept for this tab only and offers sign-in
When they open All Repacks in a new browser session
Then the default columns are shown

Coverage: Automated — `apps/frontend/lib/table-column-layout.test.ts` (session store round-trip), `apps/frontend/components/catalog/column-layout-presentation.test.ts` (persistence copy)

## Scenario: A signed-in viewer keeps the layout on the account

Given a signed-in viewer customizes the columns
When the change is made
Then it is written to the account immediately and the panel reports "Saved to your account."
And reloading on another device restores the same layout

Coverage: Automated — `convex/tableColumnLayouts.test.ts` (owner-scoped upsert and read), `apps/frontend/components/table-layout/table-column-layout-wiring.source.test.ts`

## Scenario: Signing in adopts the tab layout when the account has none

Given a signed-out viewer customized the columns in this tab
When they sign in and the account has no layout for the table
Then the tab layout is saved to the account
And the tab copy is removed

Coverage: Automated — `apps/frontend/components/table-layout/table-column-layout-wiring.source.test.ts` (adoption path present); Manual gap — end-to-end sign-in requires a live Privy session

## Scenario: Reset returns to the default and forgets the stored layout

Given a viewer has a customized layout
When they press Reset in the Columns panel
Then all fifteen columns return in the default order
And no layout remains in session storage or on the account

Coverage: Automated — `apps/frontend/lib/table-column-layout.test.ts`, `convex/tableColumnLayouts.test.ts`

## Scenario: Stored layouts survive column changes

Given an account layout that references a column that no longer exists and omits a column added later
When All Repacks renders
Then the unknown column is ignored
And the new column appears after its default neighbour, visible

Coverage: Automated — `apps/frontend/lib/table-column-layout.test.ts`

## Scenario: Another account's layout never applies, and unauthenticated writes are refused

Given user A has stored a layout
When user B reads layouts or an unauthenticated request writes one
Then user B sees no layout
And the unauthenticated write is rejected with `AUTH_REQUIRED`
And an account the closed beta has not admitted is refused by the shared capability gate before any layout state changes
And malformed layouts or unknown table keys are rejected without changing stored state

Coverage: Automated — `convex/tableColumnLayouts.test.ts`, `packages/contracts/src/table-column-layout.test.ts`
