# Task: Show Saved Repacks and Chase Cards

**ID:** watchlist/003
**Depends on:** watchlist/001, watchlist/002
**Blocks:** watchlist/004
**Delivery phase:** P02
**Estimated scope:** medium
**Estimated effort:** 4–8 hours for one builder, including empty, stale, and cap-sized list verification
**Status:** done

## Start Here

Render the Repacks and Chase cards tab panels from the owner watchlist read so each list matches its pip count, including empty and stale rows.

## Objective

A signed-in user can scan what they have saved: recognizable repacks in one tab, recognizable chase cards in the other, with honest empty and stale states.

## Context

Users can already save from the pack inspector and from desired-chase search, but they have no list. This task is the actual Watchlist content. It does not add unsave or open-in-catalog yet; those land in `watchlist/004` so P02 can merge as a complete view-only destination.

Counts on the tabs come from `watchlist/001` and are already shown by `watchlist/002`. The lists here must match those counts. A tab that says `3` must show three rows.

## Delivery Context

P02 stacks on P01 and publishes this task with `watchlist/002` in one PR. After merge, signed-in users can look at their Watchlist. Bookmark buttons elsewhere still remain the only way to unsave or to jump into a pack. P03 adds those actions on the rows.

## Requirements

### Repacks tab

- List the owner’s saved repacks newest first.
- Each resolved row shows a name the user can recognize from the catalog, plus vendor and current availability. Show the product’s estimated-value summary when the catalog provided one.
- Each unavailable row stays in the list, labeled as no longer in the catalog, and still identifiable by its stable public id if no name exists.
- A user with zero saved repacks sees an empty Repacks tab that tells them they have not saved a repack yet and points them to Dashboard or All Repacks to save one.

### Chase cards tab

- List the owner’s saved chase cards newest first.
- Each resolved row shows a name and the identity details the product already uses for a desired collectible.
- Each unavailable row stays in the list, labeled as no longer in the catalog, and still identifiable by its stable public id if no name exists.
- A user with zero saved chase cards sees an empty Chase cards tab that tells them they have not saved a chase card yet and points them to All Repacks desired-chase search to save one.

### Counts and density

- The number of rows in a tab equals that tab’s pip count from `watchlist/001`, including unavailable rows and including `0`.
- An owner at the 250-per-kind cap still gets a complete, scannable list. The page remains usable; it does not truncate silently or hang.
- Rows are repeated items, not one decorative card wrapping the whole page.

### States

- Do not present the empty copy while the watchlist read is still loading.
- A signed-in read error stays the page-level recovery from `watchlist/002`; this task does not replace it with a fake empty list.
- This task does not add unsave or open controls. Rows are for viewing.

### Accessibility and layout

- Each tab panel is labeled as the list for that kind.
- Unavailable status is not communicated by color alone.
- Keyboard users can move through the visible list. Focus stays visible.
- Text fits at supported widths with no horizontal overflow.

## User-Facing Behavior

The user opens Watchlist, sees a number on Repacks, and finds that many saved packs, newest first. They switch to Chase cards and see that many saved chase cards. Empty tabs say so and send them to save something. A pack or card that left the catalog is still listed and marked.

## Interface Contract

Rows consume `watchlist/001` fields only. Do not fetch another user’s saves or invent catalog names for unavailable ids.

`watchlist/004` will add unsave and open on these same rows. Leave a stable row identity (`publicRepackId` or `publicCollectibleId`) and the `openable` flag so those actions can attach without changing list membership rules.

Tab pips remain owned by `watchlist/002`. This task must not show a second conflicting count.

## Acceptance Criteria

- [x] A signed-in user with mixed saves sees every saved repack in Repacks and every saved chase card in Chase cards, newest first, with row counts matching the tab pips.
- [x] Empty tabs show distinct empty copy and a way to go save that kind of item.
- [x] Unavailable catalog rows remain visible and labeled, and they are included in the pip count.
- [x] A cap-sized collection renders completely and remains scannable.
- [x] Loading does not flash empty copy; a read error does not look like an empty Watchlist.

## Verification

Named scenario: **Watchlist list rendering** — empty tabs, mixed resolved and unavailable rows, newest-first order, pip-to-row count match, and a cap-sized list. Pass when both tabs match their pips and stale rows stay labeled.

Coverage: Automated — `apps/frontend/lib/watchlist.test.ts` for resolved/stale presentation, empty copy, and loading/error frames that never use empty-tab copy. The page renders the owner payload in order with no truncation.

## Spec Compliance

Rows consume `getOwnerWatchlist` fields only. Stale rows keep the public id and the “no longer in the catalog” label. `publicRepackId` / `publicCollectibleId` and `openable` remain on each row for `watchlist/004`. No unsave or open controls.
