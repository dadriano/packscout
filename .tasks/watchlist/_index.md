# Feature: Watchlist

## Start Here

Begin P01 with `watchlist/001`. Ship an owner-only watchlist read that returns both saved collections, resolved against the current catalog, with per-collection counts for the tab pips.

**Progress:** 1/4 tasks complete; 1/3 phases merged; chased-repack follow-up published

## Context

PackScout already lets a signed-in user save repacks and chase cards with bookmark controls. Those saves persist on the account, but the product never shows the list. Users cannot see what they saved, unsave from a list, or jump back to a saved pack or chase card.

Watchlist is the missing destination: a signed-in primary-nav page with two tabs, **Repacks** and **Chase cards**, each showing a count pip. It reuses today’s saved-item store. It does not add a new kind of save.

## Success Signals

- A signed-in user can open Watchlist from the top nav and recognize every saved repack and chase card.
- Each tab pip matches the number of rows in that tab, including stale rows and zero.
- From a row, the user can unsave or leave Watchlist into the existing catalog.
- Another user’s saves never appear. Signed-out visitors never see the nav item.

## Resolved Decisions

### Destination

- Watchlist is a dedicated page with its own URL, like Learn. It is not a modal, sheet, or Dashboard tab.
- Primary nav is **Dashboard | Watchlist | Learn** when the session is signed in and account saving is available.
- The Watchlist nav item is hidden while signed out, while auth is still loading, and when account saving is unavailable or the session cannot be verified.
- Opening the Watchlist URL while signed out still loads the page and asks the visitor to sign in. After sign-in they see their own lists.

### Lists and pips

- One page, two tabs: **Repacks** and **Chase cards**. Newest save first inside each tab.
- The active tab is restorable from the URL so refresh keeps Repacks or Chase cards.
- Each tab shows a count pip for that collection. The pip is always visible, including `0`.
- The pip count equals the number of rows in that tab, including saves whose catalog entry has left the current catalog. It never exceeds the existing 250-per-kind cap.
- The count is part of the tab’s accessible name. Color or a badge shape alone is not enough.

### Row actions

- A resolved repack row can unsave or leave Watchlist and open that pack’s inspector on All Repacks, including sold-out packs.
- A resolved chase-card row can unsave or leave Watchlist and open All Repacks filtered to that collectible.
- A stale row stays in the list, labeled as no longer in the catalog. Unsave still works. Open is disabled.
- Unsave matches today’s bookmark toggle: immediate, no confirmation dialog.

### Account and data

- Watchlist reads and writes the existing saved-repack and saved-chase collections. No new save type.
- Ownership comes only from the authenticated account. The browser never supplies an owner id.
- The same auth and product-capability rules that already gate saving also gate Watchlist.
- Watchlist is personal. It is not a public indexed destination and does not list another user’s saves.

## Out of Scope

### Not in v1

- Modal or sheet overlay instead of a page
- Search, extra sort, filters, or a mixed chronological feed
- Adding new saves from Watchlist (bookmark controls elsewhere still do that)
- A count pip on the Watchlist nav item itself
- Alerts when a saved pack’s EV or availability changes
- Shared, public, or collaborative watchlists

### Unchanged

- The 250-per-kind save cap and the existing capacity-prune rule
- Admin inspection or mutation of a user’s saved items
- Renaming the existing “Save repack” / “Save chase” bookmark copy

## Delivery Strategy

**Mode:** stacked
**Activation or cutover phase:** P02 makes Watchlist visible. P03 adds row actions. P01 is dormant.
**Merge order:** P01, then P02, then P03
**Temporary compatibility:** none
**Default review budget:** one reviewer thesis; up to 3 tasks; about 1–2 implementation days; target <=2,500 authored changed lines and <=25 authored files

## Delivery Phases

| Phase | Reviewable outcome | Tasks | Requires | Planned PR relationship | Verification | Status |
|---|---|---|---|---|---|---|
| P01 | Owner can read both saved collections as display-ready rows with per-tab counts | 001 | none | root on default branch | Owner-only watchlist read matrix | merged |
| P02 | Signed-in users can open Watchlist and see both lists with count pips | 002, 003 | P01 | stacked on P01 | Watchlist destination and list rendering | planned |
| P03 | Users can unsave or open a row from Watchlist | 004 | P02 | stacked on P02 | Unsave and catalog-open from a Watchlist row | planned |

### Phase Details

#### P01 — Owner watchlist read

- **After merge:** An authenticated owner can load both saved collections resolved against the current catalog. The public site is unchanged. Bookmark save/unsave behavior is unchanged.
- **Review budget:** 1 task; 3–6 hours; target at most 12 authored files and 800 authored lines.
- **Rollback:** Revert the unused owner read. Existing ID-only saved-item reads remain.
- **Size exception:** none
- **Branch:** `codex/watchlist-p01-chased-repacks`
- **Verified parent:** `1e79ff9ca961b569ca4b191e617b60dc315cc390` (`origin/main`)
- **Verified implementation:** `d341b26c5311dabd59c01c6fd8bf03ebfff3aacb`
- **PR:** https://github.com/dadriano/packscout/pull/103 (merged as `a63d98a9`); follow-up https://github.com/dadriano/packscout/pull/106

#### P02 — Watchlist page and lists

- **After merge:** Signed-in users see Watchlist in the nav, open the page, switch tabs, and scan saved repacks and chase cards with matching count pips. Rows are not yet actionable beyond viewing. Signed-out visitors still have no nav item; the URL asks them to sign in.
- **Review budget:** 2 tasks; 1–2 days total; nav plus Watchlist page as the two surfaces; target at most 20 authored files and 2,000 authored lines.
- **Rollback:** Revert the route and nav item. The owner read can remain unused.
- **Size exception:** none
- **Branch:** assigned by builder
- **Verified parent:** not recorded
- **Verified implementation:** not recorded
- **PR:** not opened

#### P03 — Act from a row

- **After merge:** A Watchlist row can unsave in place or leave Watchlist into the catalog. Stale rows stay labeled, remain unsaveable, and cannot open. Tab pips update after a successful unsave.
- **Review budget:** 1 task; 3–6 hours; Watchlist rows plus the catalog landing; target at most 12 authored files and 800 authored lines.
- **Rollback:** Revert row actions. The page can remain view-only.
- **Size exception:** none
- **Branch:** assigned by builder
- **Verified parent:** not recorded
- **Verified implementation:** not recorded
- **PR:** not opened

## Tasks

| ID | Task | Phase | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|---|
| 001 | Serve the owner's watchlist | P01 | small | 3–6 hours | done | none |
| 002 | Open the Watchlist destination | P02 | medium | 4–8 hours | todo | 001 |
| 003 | Show saved repacks and chase cards | P02 | medium | 4–8 hours | todo | 001, 002 |
| 004 | Unsave and open from Watchlist | P03 | medium | 3–6 hours | todo | 003 |

## Build Order

1. Land the chased-repack follow-up on default so Open-equivalent collectible proof is on main.
2. Stack P02 on current main. Build `watchlist/002` first, then `watchlist/003` on the same branch.
3. Stack P03 on P02 and add row actions in `watchlist/004`.

## Parallel Groups

- Group A (no deps): `watchlist/001`
- Group B (after 001): `watchlist/002`
- Group C (after 002): `watchlist/003`
- Group D (after 003): `watchlist/004`

No two numbered tasks are safe to implement in parallel. P02 still publishes 002 and 003 together.

## PR Topology

```text
default
 └── P01 owner watchlist read (#103, merged)
      └── P01 chased-repack proof (#106)
           └── P02 Watchlist page and lists
                └── P03 unsave and open from a row
```

## Next Action

Land https://github.com/dadriano/packscout/pull/106, then start P02 (`watchlist/002` and `watchlist/003`) stacked on that head.
