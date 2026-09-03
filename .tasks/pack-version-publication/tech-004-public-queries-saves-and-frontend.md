# Technical Spec: Public Queries, Saves, and Frontend Integration

**ID:** pack-version-publication/tech-004
**Related tasks:** pack-version-publication/005, pack-version-publication/007
**Depends on technical specs:** pack-version-publication/tech-001, pack-version-publication/tech-003
**Spec status:** draft

## Purpose

Serve and render all six catalog journeys directly from per-pack active heads while preserving stable URLs, saves, query intent, complete pack contents, and invisible cursor recovery.

## Current System Context

### Confirmed repository facts

- `apps/frontend/lib/public-repacks.server.ts` is the current server-only Convex boundary and validates query results before buyer components receive them.
- `apps/frontend/app/page.tsx` and `apps/frontend/app/packs/page.tsx` render the dashboard and catalog; selection is carried by stable `publicRepackId` query state.
- Current list keys, telemetry, detail reads, status presentation, and cursors also carry a catalog-wide release identity.
- `apps/frontend/lib/catalog-query-state.client.ts` already bounds cursor history and canonicalizes filters; route-state tests reject unsupported URL parameters.
- Heat is directly represented by Convex helpers, contract fields, catalog components, and frontend presentation code.

### Confirmed task constraints

- Each returned pack summary, detail, content page, odds value, chase, valuation, action, and EV value must identify one `publicPackSnapshotId`.
- Default browse shows only retirement `active` plus availability `available`; all-state, saves, and direct links can expose every lifecycle state.
- List pagination is live keyset pagination; pack-content pagination stays on one immutable snapshot so a detail traversal cannot mix versions.
- Saved keys remain stable pack/collectible identities with independent 250-item caps and exact structured errors.
- Heat and catalog-wide release identity are absent from the final query contract, URL state, presentation, and analytics.

## Proposed Implementation

### Public Convex query layer

Add `convex/packCatalogV1.ts` as the sole public catalog query module. Put head/snapshot hydration in `packCatalogReadModel.ts`, cursor signing in `packCatalogCursor.ts`, and bounded aggregation/filter helpers in `packCatalogAggregates.ts`.

Every public function has explicit Convex argument and return validators. Contract parity tests pass its output through the P01 Zod schema. Responses use this common envelope:

```ts
type PackCatalogResult<T> =
  | { ok: true; schema: "pack_catalog_v1"; evaluatedAt: string; data: T }
  | { ok: false; schema: "pack_catalog_v1"; code: PublicCatalogErrorCode; retryable: boolean };
```

No success response contains a database ID, operation record, worker state, credential, source payload, or global catalog identity.

### Per-pack read model

Pack list queries read `activePackHeads`, whose summary and sort fields were verified against the completed snapshot during activation. A query transaction sees a coherent set of heads at one Convex evaluation point. Hydration then:

1. Loads each named completed pack snapshot and verifies stable identity/content digest.
2. Loads the current provider-profile head once per provider and caches it within the query.
3. Uses sealed pack-local collectible/category/valuation data for pack rows and details.
4. Emits the active pack snapshot and joined profile snapshot identities as evidence.
5. Omits only a corrupt dependent row and returns a bounded warning; direct detail returns `DEPENDENCY_UNAVAILABLE` for that pack.

Dashboard counts, contextual facets, and KPIs use a `.take(MAX_PUBLIC_PACKS + 1)` head scan. Crossing the P01 maximum is an invariant failure rather than silently returning partial totals. List paths use a declared head index for the selected sort and advance from the last `(sortKey, publicRepackId)` tuple; bounded filtering continues until the page is full or the scan ends.

Pack-name search uses normalized search fields on active heads. Standalone collectible search uses the search index on `activeCollectibleProfileHeads`, then hydrates the one profile snapshot named by each head. Desired-collectible lookup searches the exact membership tokens copied into current `activePackHeads`, then hydrates the snapshot selected by each matching head.

### Cursor semantics

`PackCatalogCursorCodec` signs an opaque canonical envelope with the configured cursor key. The envelope binds schema, operation, normalized query fingerprint, filters, sort, direction, page size, last key, last stable identity, native continuation evidence where used, issue time, and expiry.

List, collectible-search, and desired-collectible cursors are live: a later request resolves current heads. An unrelated activation does not invalidate the cursor. If a pack's sort key crosses the boundary between requests, it may move, repeat, or be skipped as documented by the task contract.

`getPublicPack` content cursors instead bind `publicRepackId`, `publicPackSnapshotId`, batch ordinal/offset, page size, and expiry. Every content page remains on that immutable snapshot while retained; the response also returns `headAdvanced` and the current snapshot ID when the active head has moved.

Malformed, tampered, expired, wrong-operation, wrong-schema, or query-mismatched cursors return `CURSOR_EXPIRED`. Convex never silently restarts pagination.

### Query behavior

`getPublicShellStatus` reports whether at least one complete active pack is reachable and does not depend on worker availability. `getDashboardBundle` returns bounded head-derived KPIs, opportunities, facets, and optional selected-pack detail.

`listPublicPacks` returns active-head summaries, contextual facets, exact accepted query state, query fingerprint, and forward/back navigation evidence. It applies the current non-Heat filter and sort meanings under the P01 schemas.

`getPublicPack` allows every lifecycle state, returns header/detail plus the first or requested full-content page, and disables actions unless retirement is active and availability is available. A pack without an active head is `PACK_NOT_FOUND`.

`searchPublicCollectibles` returns only current collectible-profile heads. `findPacksByDesiredCollectible` validates that profile identity, applies default/all-state pack filters, verifies current pack heads, and returns pack-local sealed collectible evidence for each match.

### Saved items

Retain `convex/savedItems.ts` and rewire only resource resolution:

- A pack is saveable when `activePackHeads` contains its stable `publicRepackId`, regardless of current lifecycle.
- A collectible is saveable when `activeCollectibleProfileHeads` contains its stable identity.
- Removal is allowed when the head no longer exists; saves never store snapshot IDs.
- At capacity, prune only the oldest unreachable item of the same kind before inserting.
- Derive owner only from `tokenIdentifier`; return sorted stable IDs and bounded results/errors.

Use one Convex transaction for capacity check, optional stale prune, and insert/delete. Changed concurrent saved state returns `SAVED_ITEMS_STATE_CONFLICT` rather than optimistic drift.

### Frontend server boundary

Replace `public-repacks.server.ts` with `pack-catalog.server.ts`. It calls only generated `api.packCatalogV1.*` functions, validates the P01 result, converts expected structured errors to bounded route results, and never exposes the Convex client or server configuration to browser modules.

Server pages fetch list/dashboard data and a selected detail by stable identity. React keys use stable identity plus `publicPackSnapshotId`, never a global release. Telemetry uses stable pack/collectible identity and the response snapshot identity for entity events; catalog-wide events use query fingerprint and schema only.

### Query state and recovery

Keep accepted search, provider/category/type/lifecycle/price filters, sort, direction, page size, desired collectible, and selected stable pack in canonical URL state. A cursor stack remains bounded to P01's declared maximum.

When the server boundary receives `CURSOR_EXPIRED` with a paged request:

1. Remove cursor, cursor stack, and query fingerprint from a copy of the accepted query.
2. Retry the same operation once for its first page.
3. Return `paginationReset: true` with the preserved filters, sort, desired collectible, and resolvable selection.
4. Let the client replace the URL instead of pushing a duplicate history entry.
5. Move focus to the result heading and announce the reset through one polite live region.

No other error causes an automatic retry. A selected stable pack clears only after `PACK_NOT_FOUND`; a changed snapshot updates its content without changing the URL.

### Final UI surface

Update dashboard, packs page, tables, filters, inspector, desired-collectible search, status reporter, saved-item provider, and presentation helpers to consume V1 view types directly. Preserve semantic tables/headings, keyboard navigation, visible focus, narrow layouts, loading/empty/recovery states, and disabled-action reasons.

Delete Heat badges/details, Heat view helpers, Heat query parameters, Heat styles, Heat tests, and Heat telemetry. Remove catalog-wide release status, identifiers, response keys, query fields, and telemetry fields rather than translating them.

## Code Changes

### Convex and contracts

1. Add `packCatalogV1.ts`, `packCatalogReadModel.ts`, `packCatalogCursor.ts`, and `packCatalogAggregates.ts` with explicit validators and bounded indexed reads.
2. Add active-head indexes/search indexes from tech-003 and schema-parity fixtures for every query input/result.
3. Update `savedItems.ts` and its tests to resolve V1 heads while retaining exact identity/auth/capacity semantics.
4. Remove the current catalog query/read-model/aggregate/validation modules and Heat modules once the P07 stack consumes V1.
5. Remove their contract exports and leave `pack_catalog_v1` as the only catalog export from `packages/contracts/src/index.ts`.

### Frontend

1. Add `apps/frontend/lib/pack-catalog.server.ts` and update the dashboard and `/packs` server pages to call the six named queries.
2. Update catalog query/route state, cursor pagination, dashboard/list/inspector/search components, and saved-item presentation to use V1 types.
3. Rename the release-status reporter/helper to pack-catalog status and derive availability only from the shell response.
4. Update telemetry contract/client/route tests to use stable identities, snapshot evidence, and query fingerprints without a global catalog identity.
5. Delete unused Heat components/styles/tests and all remaining current catalog server/presentation modules after import replacement.

## Database / Schema Changes

No PostgreSQL changes.

In Convex, complete the tech-003 head layout with one explicit index per P01 sort path and filter prefix. Copy only validated index fields into `activePackHeads`; activation verifies them against snapshot summary bytes. Add search indexes to `activePackHeads` for normalized pack text and exact encoded membership tokens, plus one to `activeCollectibleProfileHeads` over normalized display name and aliases.

Keep `savedRepacks` keyed by owner token plus stable pack ID and `savedCollectibles` keyed by owner token plus stable collectible ID. Preserve indexes for owner listing, exact membership, and oldest-created stale pruning; no saved row references a snapshot.

## Interfaces, APIs, and Endpoints

The public generated Convex functions use these inputs:

```ts
getPublicShellStatus({})
getDashboardBundle({ filters, selectedPublicRepackId? })
listPublicPacks({ search, filters, sort, direction, pageSize, cursor?, queryFingerprint? })
getPublicPack({ publicRepackId, contentPageSize, contentCursor? })
searchPublicCollectibles({ search, collectibleTypes, pageSize, cursor?, queryFingerprint? })
findPacksByDesiredCollectible({ publicCollectibleId, filters, sort, direction, pageSize, cursor?, queryFingerprint? })
```

The saved mutations retain these inputs and results:

```ts
getSavedItemIds({})
setSavedRepack({ publicRepackId, saved }) -> { saved, prunedUnavailable }
setSavedCollectible({ publicCollectibleId, saved }) -> { saved, prunedUnavailable }
```

Public read errors are `INVALID_QUERY`, `CURSOR_EXPIRED`, `CATALOG_UNAVAILABLE`, `PACK_NOT_FOUND`, `COLLECTIBLE_NOT_FOUND`, `DEPENDENCY_UNAVAILABLE`, `UNAUTHORIZED`, `FORBIDDEN`, and `STATE_CONFLICT`. P01 freezes user-safe copy and retryability for each.

Saved mutations return only the exact P01 saved errors: identity errors, invalid pack/collectible IDs, unavailable resource, item limit, or state conflict.

Next routes remain `/` and `/packs`. The selected pack and desired collectible remain canonical query parameters containing stable IDs; snapshot IDs are response evidence and never route identity.

## Data Flow

### Pack list and selection

1. The route parser validates and canonicalizes URL query state through P01 schemas.
2. The server boundary calls `listPublicPacks`; Convex evaluates current heads and returns one signed next cursor.
3. An optional selected stable ID is fetched with `getPublicPack` and checked against its one snapshot ID.
4. Browser components render summaries/detail and preserve stable query state during navigation.
5. A later pack activation changes only that pack's snapshot evidence on refresh.

### Full contents

1. The initial detail query resolves the active head and returns snapshot header plus the first bounded content page.
2. Its content cursor pins that immutable snapshot and the next batch offset.
3. Later pages read only batches belonging to the pinned snapshot.
4. If the active head advances, the response signals it without mixing content.
5. Expiry or pruning produces one bounded reset path to a fresh current detail.

### Saved mutation

1. Convex derives the owner token from the authenticated session.
2. It validates the stable resource ID and current V1 head when saving.
3. It applies idempotency/capacity rules and any same-kind stale prune atomically.
4. The client replaces optimistic state with `{ saved, prunedUnavailable }` and refetches bounded IDs when pruning occurred.
5. Removal remains possible after the resource head disappears.

## Error Handling and Edge Cases

- A missing or corrupt snapshot/profile dependency fails only that pack row/detail and emits bounded `DEPENDENCY_UNAVAILABLE`; independent results continue.
- A writer pause or provider outage does not affect queries because reads depend only on completed active heads.
- A list cursor race follows documented live behavior; a detail content cursor never crosses snapshot IDs.
- Invalid URL state renders a reset link without calling Convex; `CURSOR_EXPIRED` retries once and all other structured errors render directly.
- Signed-out save, capacity refusal, stale prune, concurrent state conflict, and missing-head removal reconcile from server truth without leaking auth or storage details.

## Testing and Verification

1. Run contract and Convex tests for all six queries across two independently activating packs, profile joins, every lifecycle state, cursor tampering/expiry, and missing dependencies.
2. Assert list/summary/detail/content/desired lookup byte agreement by `publicPackSnapshotId`, including activation between list pages and between content pages.
3. Run saved-item tests for auth identity, exact 250 caps, sorted IDs, idempotency, stale removal, same-kind pruning, and state conflict.
4. Run route, query-state, presentation, telemetry, keyboard, focus, live-region, narrow-layout, and error-state tests with no Heat/global identity fields.
5. Exercise the six journeys in a production build against local Convex fixtures, then run `npm run verify:framework`.

The named scenario is **Six-journey V1 frontend acceptance**, combined with the read/save portion of **Atomic store and six-journey catalog contract**.

## Open Questions and Risks

- The bounded 8,000-head dashboard/filter scan is simple and exact but needs a P05 latency test at maximum fixture size. If it misses the agreed budget, add per-pack derived index documents or Convex-supported aggregates without making a provider or catalog release the consistency unit.
- P05 and P07 touch opposite ends of one compile-time contract. Develop them as a stack: P05 adds dormant V1 modules; the final P07 stack switches all imports and removes the prior catalog/Heat modules before P08. If default-branch merges deploy automatically, merge/deploy the completed stack as one candidate artifact rather than add a runtime selector or translation layer.
- Snapshot-pinned content pagination favors a coherent long detail read over immediate refresh. The UI must visibly offer a refresh when `headAdvanced` is true but must not combine old and new content pages.

## Handoff Notes

P05 owns the Convex read functions, cursor codec, saved-item rewiring, and server-safe result contracts. P07 owns direct route/component integration, cursor recovery, accessibility, telemetry, and removal of all superseded catalog/Heat source from the candidate artifact.

The next reviewer check is cross-journey identity: choose one pack, then prove dashboard, list, detail, desired-collectible lookup, save, and direct link all retain its stable ID and resolve every pack-local field from one active snapshot ID.
