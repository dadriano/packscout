# Task: Unsave and Open from Watchlist

**ID:** watchlist/004
**Depends on:** watchlist/003
**Blocks:** none
**Delivery phase:** P03
**Estimated scope:** medium
**Estimated effort:** 3–6 hours for one builder, including stale-row, pip-update, and catalog-landing verification
**Status:** todo

## Start Here

On a Watchlist row, make Unsave remove that save in place and make Open leave Watchlist into the existing catalog destination for that item.

## Objective

A signed-in user can manage Watchlist from the list itself: drop a save, or jump back to the pack or chase card they saved, without hunting the original bookmark control.

## Context

P02 made Watchlist visible and filled the tabs. Without this task, the page is a dead end. The product already has save/unsave mutations and catalog destinations. This task connects those to Watchlist rows.

Open must leave Watchlist. The earlier modal idea was rejected; Watchlist is a page. Opening a pack therefore navigates to All Repacks with that pack’s inspector, including sold-out packs that Overview would omit. Opening a chase card navigates to All Repacks filtered to that collectible, which is the existing desired-chase path.

Unavailable rows remain on the list. The user can still unsave them. They cannot open them, because there is no catalog item to inspect.

## Delivery Context

P03 stacks on P02. After merge, Watchlist is complete for v1: view, counts, unsave, and open. Do not add search, alerts, or a nav-item pip here.

## Requirements

### Unsave

- Every row, resolved or unavailable, can be unsaved from Watchlist.
- Unsave uses the same account save store as the bookmark buttons. After a successful unsave, the item is no longer saved, and the matching bookmark control elsewhere shows unsaved.
- Unsave is immediate, with no confirmation dialog, matching today’s bookmark toggle.
- On success, the row leaves the list and that tab’s pip decreases by one.
- While the unsave is in flight, the row does not accept a second activation. Status copy tells the user the save is being removed.
- If unsave fails, the row stays, the pip does not change, and the user gets an error they can retry.

### Open

- A resolved, openable repack row leaves Watchlist and opens that pack’s inspector on All Repacks, including sold-out packs.
- A resolved, openable chase-card row leaves Watchlist and opens All Repacks filtered to that collectible as the desired chase.
- An unavailable row does not offer an enabled Open action. Unsave remains available.
- Open is a navigation action, not a second overlay on Watchlist.

### States and access

- Signed-out, save-unavailable, and unverifiable-session pages still have no row actions; `watchlist/002` frames remain in charge.
- An account that cannot save also cannot unsave from Watchlist.
- Unsave and Open have visible labels or accessible names. Disabled Open on a stale row states why.
- Keyboard users can reach Unsave and Open in a logical order. Focus remains visible.

## User-Facing Behavior

The user opens Watchlist, unsaves a pack, and sees it disappear while the Repacks pip drops. They open a remaining pack and land on All Repacks with that pack inspected. They open a chase card and land on All Repacks already filtered to that card. A stale row still unsaves, but Open stays off.

## Interface Contract

Mutations are the existing owner save/unsave operations. This task does not add a second store or a second owner field.

After a successful unsave, `watchlist/001`’s collections and counts are the source of truth for list membership and pips. Bookmark buttons that already consume saved-item ids must agree with Watchlist without a dual-write path.

Open targets:

- Repack: All Repacks with that `publicRepackId` selected so the pack inspector can show it, including sold-out availability.
- Chase card: All Repacks with that `publicCollectibleId` applied as the desired-chase filter.

## Acceptance Criteria

- [ ] Unsaving a resolved row removes it from that tab, decrements the pip, and leaves the bookmark control unsaved for the same item.
- [ ] Unsaving an unavailable row also removes it and decrements the pip.
- [ ] A failed unsave keeps the row and pip unchanged and shows a retryable error.
- [ ] Opening a resolved repack leaves Watchlist and shows that pack’s inspector on All Repacks, including when the pack is sold out.
- [ ] Opening a resolved chase card leaves Watchlist and shows All Repacks filtered to that collectible; unavailable rows cannot open.

## Verification

Named scenario: **Watchlist row actions** — unsave success and failure, pip update, bookmark-button agreement, sold-out pack open, desired-chase open, and disabled open on a stale row. Pass when those outcomes are observed in the product and the focused tests covering them exit 0.
