# Task: Open the Watchlist Destination

**ID:** watchlist/002
**Depends on:** watchlist/001
**Blocks:** watchlist/003
**Delivery phase:** P02
**Estimated scope:** medium
**Estimated effort:** 4–8 hours for one builder, including signed-out URL, nav visibility, and tab pip shells
**Status:** done

## Start Here

Add Watchlist as a signed-in primary-nav destination and load its page with two tabs, each showing a count pip, including the signed-out URL sign-in state.

## Objective

A signed-in user can find and open Watchlist the same way they find Dashboard and Learn. A signed-out visitor does not see the nav item, but the Watchlist URL still explains that they need to sign in.

## Context

Primary nav today is Dashboard and Learn. Dashboard has Overview and All Repacks as inner tabs. Watchlist is a separate product area: personal saved items, not the public catalog.

The account menu already says saved repacks and chase collectibles sync to the account, but it does not open a list. Watchlist is that list. It must be easy to find after sign-in and invisible in the nav before sign-in, so the public catalog chrome stays the same for anonymous visitors.

`watchlist/001` supplies loading, error, and count data. This task owns the destination: route, nav, page heading, tabs, pip shells, and signed-out / unavailable / loading / error frames. `watchlist/003` fills the rows.

## Delivery Context

P02 stacks on P01. This task and `watchlist/003` ship in the same PR. After this task alone, the destination exists but lists may still be empty placeholders. The phase is not mergeable until `watchlist/003` also lands, so reviewers see real saved items. Row unsave and open stay in P03.

## Requirements

### Navigation

- Add **Watchlist** to the primary nav beside Dashboard and Learn when the session is signed in and account saving is available.
- Hide the Watchlist nav item while signed out, while auth is still loading, when account saving is unavailable, and when the session cannot be verified.
- Mark Watchlist as the current destination while the user is on the Watchlist page.
- Keep Dashboard and Learn current-page behavior unchanged on their existing routes.

### Page

- Watchlist is a normal dedicated page with its own URL, not a modal or sheet.
- The page heading is **Watchlist**.
- The page has two tabs: **Repacks** and **Chase cards**. Exactly one tab is selected.
- The selected tab is restorable from the URL so refresh and shared links keep the same tab.
- Each tab shows a count pip from `watchlist/001` (`savedRepackCount` on Repacks, `savedCollectibleCount` on Chase cards). The pip is always visible, including `0`.
- The pip value is included in the tab’s accessible name. Do not rely on color or badge shape alone.
- Watchlist is a personal destination and must not be advertised as a public indexed page.

### Signed-out and unavailable

- Opening the Watchlist URL while signed out renders the page and asks the visitor to sign in. It does not redirect away, 404, or show another user’s data.
- After a successful sign-in from that prompt, the visitor sees their own Watchlist.
- When account saving is unavailable or the session cannot be verified, the page explains that Watchlist cannot load, using the same class of copy already used for save controls.

### Loading and error

- While the owner watchlist read is loading, the page does not flash an empty “you have nothing saved” state.
- If the owner watchlist read fails after the user is signed in, the page shows a recoverable error, not a blank shell and not another user’s data.
- Empty-tab copy is owned by `watchlist/003`. This task only reserves the tab panels.

### Accessibility and layout

- Keyboard users can reach the Watchlist nav item (when visible) and move between the two tabs in a logical order.
- Focus is visible. The page heading is the route heading for the destination.
- Layout stays readable at supported widths with no horizontal overflow.
- Motion, if any, respects `prefers-reduced-motion`.

## User-Facing Behavior

A signed-in user sees **Watchlist** in the top nav, opens it, and lands on a Watchlist page with Repacks and Chase cards tabs. Each tab shows a number. Switching tabs keeps that choice on refresh. A signed-out user browsing Dashboard does not see Watchlist in the nav. If they still open the Watchlist URL, they are asked to sign in.

## Interface Contract

`watchlist/003` renders inside the selected tab panel. It receives the matching collection from `watchlist/001` and must not invent a second nav, page heading, or pip source.

`watchlist/004` does not add destinations. It only adds actions on rows inside these tabs.

Tab pip values are the counts from `watchlist/001`, not a separate client-side tally, until `watchlist/004` unsaves a row and the read updates.

## Acceptance Criteria

- [x] A signed-in user with account saving available sees Watchlist in the primary nav, can open it, and sees Repacks and Chase cards tabs with count pips, including `0`.
- [x] A signed-out visitor does not see Watchlist in the nav; opening the Watchlist URL shows a sign-in prompt and no saved rows.
- [x] Auth loading, save-unavailable, and unverifiable-session states hide the nav item and do not present another user’s Watchlist.
- [x] Refresh keeps the selected tab. Each tab’s accessible name includes its count.
- [x] The Watchlist destination is not treated as a public indexed page.

## Verification

Named scenario: **Watchlist destination and auth frames** — signed-in nav and page, signed-out hidden nav plus URL sign-in prompt, loading without empty flash, unavailable/session-error copy, and tab pip/accessible-name pairing. Pass when those frames are observed and no other user’s data appears.

Coverage: Automated — `apps/frontend/lib/watchlist.test.ts`, `apps/frontend/lib/access-gate.server.test.ts`, `apps/frontend/app/route-access-gate.source.test.ts`. Live `/watchlist` on the P02 frontend served `Watchlist · PackScout` with `noindex, nofollow`; local Convex was down, so the gate fail-closed to `/access` instead of the signed-out prompt.

## Spec Compliance

Destination is a dedicated `/watchlist` page with Dashboard | Watchlist | Learn nav gated on signed-in account saving. Signed-out visitors still hit the route (no `resolveGatedRoute` bounce to `/`); held/undetermined still hold. Metadata is always noindex.
