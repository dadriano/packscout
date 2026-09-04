# Task: Unsave and Open from Watchlist

**ID:** watchlist/004
**Depends on:** watchlist/003
**Blocks:** none
**Delivery phase:** P03
**Estimated scope:** medium
**Estimated effort:** 3–6 hours for one builder, including stale-row, pip-update, and inspector verification
**Status:** done

## Start Here

On a Watchlist row, make Unsave remove that save in place and make Open show the existing pack or chase inspector on Watchlist.

## Objective

A signed-in user can manage Watchlist from the list itself: drop a save, or inspect the pack or chase card they saved, without hunting the original bookmark control.

## Context

P02 made Watchlist visible and filled the tabs. Without this task, the page is a dead end. The product already has save/unsave mutations and catalog inspectors. This task connects those to Watchlist rows.

Open stays on Watchlist. The original “leave Watchlist and land on All Repacks” path was overridden: users asked to click a row and see more information here. Packs reuse `RepackInspector` as a sheet. Chase cards reuse `ChaseCollectibleInspector`. A chase pack pick opens the pack sheet on the same page.

Unavailable rows remain on the list. The user can still unsave them. They cannot open them, because there is no catalog item to inspect.

## Delivery Context

P03 stacks on P02. After merge, Watchlist is complete for v1: view, counts, images, unsave, and inspect. Do not add search, alerts, or a nav-item pip here.

## Requirements

### Images

- Resolved rows show the catalog primary image when the owner watchlist payload includes one.
- Missing artwork uses the existing catalog image fallback. Stale rows have no artwork.

### Unsave

- Every row, resolved or unavailable, can be unsaved from Watchlist.
- Unsave uses the same account save store as the bookmark buttons. After a successful unsave, the item is no longer saved, and the matching bookmark control elsewhere shows unsaved.
- Unsave is immediate, with no confirmation dialog, matching today’s bookmark toggle.
- On success, the row leaves the list and that tab’s pip decreases by one.
- While the unsave is in flight, the row does not accept a second activation. Status copy tells the user the save is being removed.
- If unsave fails, the row stays, the pip does not change, and the user gets an error they can retry.

### Open

- A resolved, openable repack row opens that pack’s inspector on Watchlist, including sold-out packs.
- A resolved, openable chase-card row opens the chase inspector on Watchlist. Choosing a pack from that inspector opens the pack sheet on the same page.
- An unavailable row does not offer an enabled Open action. Unsave remains available.
- Open is an inspect command, not a navigation away from Watchlist.

### States and access

- Signed-out, save-unavailable, and unverifiable-session pages still have no row actions; `watchlist/002` frames remain in charge.
- An account that cannot save also cannot unsave from Watchlist.
- Unsave and Open have visible labels or accessible names. Disabled Open on a stale row states why.
- Keyboard users can reach Unsave and Open in a logical order. Focus remains visible.

## User-Facing Behavior

The user opens Watchlist, unsaves a pack, and sees it disappear while the Repacks pip drops. They open a remaining pack and see that pack’s inspector without leaving Watchlist. They open a chase card and see chase details, and can open one of its packs from there. A stale row still unsaves, but Open stays off.

## Interface Contract

Mutations are the existing owner save/unsave operations. This task does not add a second store or a second owner field.

After a successful unsave, `watchlist/001`’s collections and counts are the source of truth for list membership and pips. Bookmark buttons that already consume saved-item ids must agree with Watchlist without a dual-write path.

The owner watchlist payload includes `primaryImage` on resolved rows. Pack inspect reads the gated `GET /api/repacks/:publicRepackId` adapter, which uses the active catalog release. Chase inspect keeps using `GET /api/collectibles/:id/repacks`.

## Acceptance Criteria

- [x] Unsaving a resolved row removes it from that tab, decrements the pip, and leaves the bookmark control unsaved for the same item.
- [x] Unsaving an unavailable row also removes it and decrements the pip.
- [x] A failed unsave keeps the row and pip unchanged and shows a retryable error.
- [x] Opening a resolved repack shows that pack’s inspector on Watchlist, including when the pack is sold out.
- [x] Opening a resolved chase card shows the chase inspector on Watchlist; unavailable rows cannot open.

## Verification

Named scenario: **Watchlist row actions** — unsave success and failure, pip update, bookmark-button agreement, sold-out pack inspect, chase inspect, and disabled open on a stale row. Pass when those outcomes are observed in the product and the focused tests covering them exit 0.

Coverage: Automated — `apps/frontend/lib/watchlist.test.ts` for inspect/remove presentation, `apps/frontend/app/api/repacks/[publicRepackId]/route.behavior.test.ts` for gated pack inspect, `convex/ownerWatchlist.test.ts` for `primaryImage` on resolved rows. Live browser smoke of signed-in Watchlist is still required after Convex and frontend deploy.

## Spec Compliance

Open is an on-page inspector, not navigation to All Repacks. That diverges from the original `watchlist/004` decision and from the feature index “leave Watchlist into the catalog” language; both were updated to match the product request for a details modal. Unsave still has no confirmation, matching the bookmark toggle and overriding the generic destructive-confirmation layout rule for this control. Pack inspect uses a new admitted `GET /api/repacks/:publicRepackId` adapter because the catalog read token is server-only.
