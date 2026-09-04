# Task: Serve the Owner's Watchlist

**ID:** watchlist/001
**Depends on:** none
**Blocks:** watchlist/002, watchlist/003
**Delivery phase:** P01
**Estimated scope:** small
**Estimated effort:** 3–6 hours for one builder, including owner-isolation and stale-row verification
**Status:** done

## Start Here

Prove one authenticated owner can load both of their saved collections, resolved against the current catalog, with a count for each collection that matches the rows returned.

## Objective

A signed-in user can retrieve a display-ready Watchlist: saved repacks and saved chase cards they own, newest first, including saves that have left the current catalog, plus a count for each tab pip.

## Context

Bookmark controls already save and unsave repacks and chase cards on the signed-in account. The product only loads identifier sets so those buttons know their pressed state. Watchlist needs recognizable rows: name, catalog status, and enough identity to open later.

Saved rows outlive catalog refreshes. A save can point at a pack or chase card that is gone from the current catalog. Watchlist must still return that row, labeled unresolved, rather than hiding or deleting it. The existing 250-per-kind cap still bounds each collection.

This read is owner-only. It is not the admin inspection path. The public site stays unchanged after this phase.

## Delivery Context

P01 is the root phase and branches from the repository default branch. Its review promise is a complete, tested owner watchlist read with no user-visible route or nav change. After merge, bookmark save/unsave and identifier-only reads keep working. P02 consumes this read to render the page.

## Requirements

### Ownership and access

- Return only the authenticated owner’s saved repacks and saved chase cards.
- Derive the owner from the verified session. Refuse an unauthenticated or invalid identity with the same class of errors already used for saved-item reads.
- Apply the same product-capability rules that already gate saving. An account that cannot save also cannot read a Watchlist.
- Never accept an owner id from the client. Never return another user’s saves.

### Collections

- Return two collections: saved repacks and saved chase cards.
- Order each collection newest save first. Use a deterministic tie-break on the public id when two saves share a timestamp.
- Bound each collection at the existing 250-per-kind cap. A full account still returns a complete, usable payload.
- Include saves whose catalog reference is missing from the current catalog. Do not drop, auto-remove, or rewrite those rows.

### Resolution

- Resolve each saved public id against the current catalog.
- For a resolved repack, include a recognizable name plus vendor, current availability, and the product’s estimated-value summary when the catalog has one.
- For a resolved chase card, include a recognizable name plus the same identity details the product already uses to describe a desired collectible.
- For an unresolved row, include the stable public id and a clear catalog-unavailable status. Do not invent a name or EV.
- Say whether a row can be opened in the catalog: resolved rows can; unresolved rows cannot.

### Counts

- Include a count for each collection that equals the number of rows returned for that collection, including unresolved rows.
- A user with no saves of a kind returns count `0` and an empty list for that kind.
- Counts never exceed the per-kind cap.

## User-Facing Behavior

None in this phase. Later tasks use this read to fill Watchlist tabs and pips.

## Interface Contract

`watchlist/002` and `watchlist/003` consume one owner watchlist payload:

- `savedRepacks`: newest-first rows, each with `publicRepackId`, saved-at, catalog status (`resolved` or `unavailable`), openable flag, and resolved display fields when status is `resolved` (name, vendor, availability, estimated-value summary when present).
- `savedCollectibles`: newest-first rows, each with `publicCollectibleId`, saved-at, catalog status, openable flag, and resolved collectible identity fields when status is `resolved`.
- `savedRepackCount` and `savedCollectibleCount`: integers equal to the corresponding array lengths, including unavailable rows, used as tab pip values.

Unauthenticated, invalid-identity, capability-refused, and catalog-unreadable failures stay structured and do not leak another owner’s rows. Existing identifier-only saved-item reads and save/unsave mutations remain available and unchanged.

## Acceptance Criteria

- [x] An authenticated owner receives both collections, newest first, with counts that match row lengths, including a `0`/empty pair when they have saved nothing of that kind.
- [x] A second authenticated owner cannot read the first owner’s rows.
- [x] Unauthenticated and invalid-identity callers are refused without a Watchlist payload.
- [x] A save whose catalog entry has left the current catalog is still returned, marked unavailable, not openable, and included in that tab’s count.
- [x] An owner at the per-kind cap receives a complete bounded collection; no row is silently truncated.

## Verification

Named scenario: **Owner watchlist read matrix** — two owners, empty collections, mixed resolved and unavailable rows, newest-first order, cap-sized collections, and unauthenticated refusal. Pass when counts match rows, unavailable saves remain, and no cross-owner leak occurs.

Covered by `convex/ownerWatchlist.test.ts`. `npx vitest run convex/ownerWatchlist.test.ts convex/savedItems.test.ts convex/productUserCapabilityGate.test.ts convex/publicCatalogReadAccess.test.ts convex/authoritativeAdminSurfaceParity.test.ts` exited 0. `npm run typecheck:convex` and `npm run scan:framework-standards:ratchet` exited 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented as specified
- Divergences: none
- Later sections: Watchlist uses the save-equivalent standing policy (`PRODUCT_USER_WRITE_CAPABILITY`) so a suspended account cannot read it while the closed beta is off. The public read is an action that mints Convex's evaluation clock and resolves rows against the same active V3 catalog the public site serves (`loadActiveDataReleaseV3`), including displayed EV, row/detail/facts checks, parsed collectible contracts, and batched bounded chase validation (`loadDesiredChases`). Duplicate public ids in that V3 release refuse `SAVED_ITEMS_STATE_CONFLICT`.
- Verification: owner watchlist read matrix, suspended/beta-off refusal, cross-provider duplicate refusal, capability-gate enumeration, public-query classification, Convex typecheck, framework ratchet
