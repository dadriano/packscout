# Technical Spec: Convex Read Model and Next Integration

**ID:** repack-dashboard/tech-003
**Related tasks:** repack-dashboard/002, repack-dashboard/003, repack-dashboard/004, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on technical specs:** repack-dashboard/tech-001, repack-dashboard/tech-002
**Spec status:** draft

## Start Here

Initialize Convex and run its code generator, then read the generated `convex/_generated/ai/guidelines.md` completely before creating `convex/schema.ts` or any Convex function.

## Purpose

Expose one bounded, reactive, frontend-safe catalog read model to the Next.js 16 routes without letting browser code reach PostgreSQL, pipeline services, tenant state, or provider internals.

## Current System Context

### Confirmed repository facts

- Current `main` has no `convex/` directory, Convex dependency, generated Convex API, public catalog contract, or generated Convex guidance file.
- `apps/frontend/app/page.tsx` is the one-page Basecamp placeholder; `apps/frontend/app/layout.tsx` and `apps/frontend/app/globals.css` still own its metadata and visual foundation.
- `apps/frontend/package.json` uses Next.js 16.2, React 19.2, and Tailwind 3.4; server loading and browser interaction are not split into feature files yet.
- `apps/frontend/next.config.ts` applies the current security headers; CSP and action-boundary changes are owned by `repack-dashboard/tech-004`.
- `apps/frontend/app/api/health/route.ts` is liveness-only and must not become a data, freshness, or dependency-health endpoint.

### Post-PR-merge foundation

PR `dadriano/packscout#1` at head `0dc6bcc25d73704b74fcfe865dd03e520c178a38` adds the canonical pipeline paths below, but it adds no Convex schema, public publisher, public listing query, or frontend route integration.

| Existing after merge | Boundary implication |
|---|---|
| `packages/database/src/schema/canonical.ts` | Authoritative stable identity and immutable canonical revisions; never queried by the browser |
| `packages/services/src/catalog-projection-contracts.ts` | Canonical pack/asset inputs consumed only by the `tech-001` assembler, never by this read layer or the `tech-002` transport publisher |
| `packages/services/src/estimated-ev-projection-contracts.ts` | Estimate inputs consumed only by the `tech-001` assembler; the public read model receives materialized values |
| `packages/services/src/provider-health-service.ts` | Internal source evidence sanitized into the committed `tech-001` snapshot/observation boundary before Convex publication |
| `packages/contracts/src/index.ts` | Public package entry point that must export the new browser-safe catalog contract |

The merged repository still treats PostgreSQL as canonical. Convex contains only rebuildable public snapshots and approved frontend configuration. No UI flow writes catalog facts back to Convex or PostgreSQL.

### Official Convex integration constraints

- [Next App Router server rendering](https://docs.convex.dev/client/nextjs/app-router/server-rendering) uses `preloadQuery` plus `usePreloadedQuery`; multiple independent preloads are not a coherent snapshot boundary, so each route uses one composite initial preload.
- [Queries](https://docs.convex.dev/functions/query-functions) are cached and reactive, which keeps a preloaded route subscribed to complete active-snapshot changes after hydration.
- [Pagination](https://docs.convex.dev/database/pagination) can return variable native page sizes; PackScout instead slices its immutable compact query projection to an explicit maximum and still treats every page as up to 25 rows.

## Proposed Implementation

### Convex prerequisite gate

1. Add the approved Convex packages and initialize the repository-root `convex/` project without hand-authoring generated files.
2. Run Convex code generation until `convex/_generated/ai/guidelines.md`, `convex/_generated/api.*`, and the generated data-model types exist.
3. Read `convex/_generated/ai/guidelines.md` completely and reconcile this spec with its required schema, index, pagination, and Next.js APIs.
4. Stop implementation if the generated guidance conflicts with an assumed API; update the technical spec before changing the product contract.
5. Keep every file under `convex/_generated/` generator-owned.

### Ownership boundaries

- `repack-dashboard/tech-001` owns the only canonical-to-public assembler and committed `CatalogSnapshotV1`/observation ledger boundary.
- `repack-dashboard/tech-002` owns publication of that boundary into the one approved Convex schema; it never re-projects canonical tables.
- `convex/` owns sanitized storage, public validation, bounded reads, search, and reactive subscriptions from the active published snapshot.
- Next server components normalize route input and issue one initial preload; client components own draft/accepted state, selection, URL history, focus, and reactive replacement.
- `packages/contracts` owns runtime-neutral public DTOs and discriminated result unions; browser code imports only its public entry point.

### Initial route loading

Every route that renders the shared freshness region issues exactly one server preload. The route query includes the shell metadata it needs, so the root layout does not issue a second data request.

| Route surface | One initial preload | Other content |
|---|---|---|
| `/` | `getDashboardBundle` | Four KPIs, six opportunities, summaries, initial detail, facets, and snapshot metadata |
| `/packs` | `listPublicPacks` | Up to 25 rows, initial selected detail, facets, cursors, range, and snapshot metadata |
| `/learn` | `getPublicShellStatus` | Three-guide typed local registry |
| `/learn/[slug]` | `getPublicShellStatus` | One typed local guide or `notFound()` |
| Shared not-found | `getPublicShellStatus` | Local not-found copy and navigation |

`apps/frontend/app/layout.tsx` creates one `ConvexReactClient` through a small client provider. Each data-backed route calls `preloadQuery` once in its server `page.tsx`, passes the typed preload to its route client, and hydrates it with `usePreloadedQuery`. Accepted search, filter, sort, and pagination changes navigate to canonical URL state so the replacement server render supplies one new preload; a React transition retains the accepted page until it arrives. `usePreloadedQuery` remains reactive for complete snapshot changes at the same arguments.

Row selection stays local and uses the selected detail already present for the initial row. Selecting another row may issue only the snapshot-bound `getPublicPack` point query; it never reloads aggregates, changes URL/cursor state, or reads detail from a different snapshot.

### Read behavior

1. Resolve the single active completed snapshot before reading rows, facets, aggregates, or detail.
2. Validate and normalize the complete request before applying any fragment of it.
3. Read only records carrying that snapshot ID and return snapshot metadata in the same result.
4. Return a discriminated application result rather than making UI state depend on transport status or thrown error text.
5. Let reactive publication replace a complete result only after the new snapshot is active.

### Query and pagination state

- Canonical URL keys are `q`, repeated `platform`, repeated `category`, `minPrice`, `maxPrice`, `sort`, `direction`, `cursor`, `cursorStack`, and `queryFingerprint`.
- Repeated facets are trimmed, de-duplicated, and sorted before serialization; selection remains browser state and is not shareable query state.
- The query fingerprint is SHA-256 over the active snapshot ID plus the normalized search, facets, price state, sort, direction, and page size.
- `cursorStack` is a base64url-encoded bounded array of opaque page-start cursors, limited to 40 entries and 4 KiB encoded; raw cursors are never logged or placed in telemetry.
- Next pushes the current cursor before moving forward and pops it for Previous, so refresh, back, and forward restore the exact valid cursor page.

Malformed cursor state returns `INVALID_QUERY`. A valid cursor whose snapshot binding no longer matches returns the first page of the new snapshot with `paginationReset: "snapshot_changed"`; the client clears `cursor` and `cursorStack`, replaces the URL fingerprint, preserves filters, and preserves selection only when that pack remains eligible.

### Search, filters, and sorting

- Empty search uses the direction-specific metric keys already stored in compact query-shard rows and defaults to EV $ descending; public pack ID is the final tie break.
- Non-empty search uses the versioned PackScout relevance tiers over compact query-shard fields and returns that relevance order unchanged.
- Metric sort arguments remain serialized while searching but are ignored by the query and hidden as operative controls until search is cleared.
- Unavailable sortable values are ranked after all available values in both ascending and descending directions.
- The full $10–$12,000 price state applies no price predicate and retains price-unavailable rows; any explicitly narrowed range excludes price-unavailable rows.

Platform facet counts apply the accepted search, price, and category constraints but ignore the platform selection itself. Category facet counts apply search, price, and platform constraints but ignore the category selection itself. Search and facet evaluation remain inside the bounded Convex query over `catalogQueryShards`; the browser never fetches a full catalog to filter, aggregate, or re-sort.

### Deterministic relevance

1. Normalize the query and candidate fields with Unicode NFKC, locale-independent lowercase, punctuation-to-space, whitespace collapse, and de-duplicated tokens.
2. Exclude a candidate unless every query token is a prefix of a token in pack name, platform display name, or category.
3. Rank exact normalized Pack name first, Pack-name phrase prefix second, all tokens in Pack name third, and cross-field token matches fourth.
4. Within one tier, rank more Pack-name token matches first, then normalized Pack name, then stable public pack ID.
5. Version this algorithm as `packscout_relevance_v1` in the snapshot manifest; never add EV or another metric as a search tie break.

### Learn content

`apps/frontend/lib/learn-content.ts` is the only guide registry. It exports a typed three-record tuple in this exact order: `what-is-a-repack`, `expected-value`, and `repack-red-flags`. The same module owns shared metric definitions used by glossary links and guide copy. Learn has no Convex content table, CMS adapter, remote authoring fallback, or catalog-search indexing.

## Code Changes

### Repository-root and post-merge package paths

| Path | Change |
|---|---|
| `convex/schema.ts` | Define the sanitized snapshot, pack, compact catalog-query-shard, and bounded read tables established below |
| `convex/publicCatalog.ts` | Implement `getPublicShellStatus`, `getDashboardBundle`, `listPublicPacks`, and `getPublicPack` |
| `convex/publicCatalogValidation.ts` | Normalize public input, create query fingerprints, validate cursors, and map stable results |
| `packages/contracts/src/public-catalog.ts` | Add public values, DTOs, query inputs, result unions, and stable error codes after PR #1 merges |
| `packages/contracts/src/index.ts` | Export the catalog contract without exposing package-internal source paths |

The publisher created by `repack-dashboard/tech-002` consumes only the validated `CatalogSnapshotV1` or unchanged observation from `repack-dashboard/tech-001` and its committed ledger row. It must not consume projection contracts or read PostgreSQL directly. Frontend files must not import service modules.

### Next.js route and integration paths

| Path | Change |
|---|---|
| `apps/frontend/app/layout.tsx` | Replace Basecamp metadata, install the Convex client provider, and retain server/client separation |
| `apps/frontend/app/page.tsx` and `apps/frontend/app/DashboardOverviewClient.tsx` | Preload one Dashboard bundle and own reactive Overview interaction |
| `apps/frontend/app/packs/page.tsx` and `apps/frontend/app/packs/AllPacksClient.tsx` | Preload one catalog page and own URL-backed exploration |
| `apps/frontend/app/learn/page.tsx` and `apps/frontend/app/learn/[slug]/page.tsx` | Preload shell status while rendering only local typed content |
| `apps/frontend/app/not-found.tsx` | Keep the shared shell around unknown routes and slugs |

Shared UI belongs under `apps/frontend/components/shell/`, `apps/frontend/components/catalog/`, and `apps/frontend/components/pack/`. Browser state helpers belong in `apps/frontend/hooks/use-catalog-query-state.client.ts` and `apps/frontend/lib/catalog-query-state.client.ts`; preload and route normalization belong in `apps/frontend/lib/public-catalog.server.ts`.

### Read-recovery paths

| Path | Change |
|---|---|
| `apps/frontend/components/catalog/CatalogReadBoundary.tsx` | Retain the last accepted result across client subscription/runtime failure and expose stable local Retry feedback. |
| `apps/frontend/components/catalog/CatalogReadBoundary.test.tsx` | Prove cached retention, retry, recovery replacement, focus, and no internal error copy. |
| `apps/frontend/app/error.tsx` | Render the no-cache route-level recovery state for Dashboard/server-preload failure. |
| `apps/frontend/app/packs/error.tsx` | Render the no-cache All Packs recovery state without fabricating rows or metrics. |
| `apps/frontend/lib/public-read-recovery.client.test.ts` | Cover transport/runtime classification independently from application result codes. |

## Database / Schema Changes

### Logical Convex tables

| Table | Required public content |
|---|---|
| `catalogState` | The sole active pointer plus previous safe pointer and latest successful observation/freshness metadata defined by `tech-002` |
| `catalogSnapshots` | Immutable manifest/config arrays, hashes/counts, and lifecycle states `staging`, `complete`, `failed`, `retired`, or `blocked`; lifecycle never grants active authority |
| `publicPacks` | Snapshot/public IDs, display identity, availability, category, price, EV values, buyback coverage, deterministic primary image, top chase, action availability, source/calculation times |
| `catalogQueryShards` | Snapshot/shard identity plus compact normalized search fields, facet keys, availability, USD comparison values, null ranks, and direction keys |
| `publicationBatches` | Write/reconciliation/retention receipts owned by `tech-002`; public query handlers never access them |

Use exactly the schema and indexes owned by `tech-002`; this spec adds no table or competing state authority. Approved public configuration is a bounded immutable array in `catalogSnapshots`, with relevant display/action fields copied into `publicPacks`; there is no standalone config table. A public query may collect compact shards for one immutable snapshot but never the full detailed `publicPacks` table. It filters, ranks, sorts, counts facets, and slices the cursor page inside Convex, then loads only selected and visible detail documents.

`tech-002` also owns internal-only `publicationOperations` and `blockedCatalogManifests`. Read functions in this spec never query or expose them and never use them as a public state authority.

### Value and identity rules

- Stable public pack ID is publisher-derived from canonical platform key plus pack identity and never exposes organization, provider, entity, revision, or source-record IDs.
- Money remains integer minor units with explicit currency; signed EV $ and signed EV % are authoritative materialized snapshot values that presentation formats but does not independently recompute.
- Buyback represents provider-supported coverage, whether received directly or derived by the approved pipeline; it is not always described as provider-reported.
- Missing price, EV, buyback, chase, image, promo, or listing uses an explicit nullable/value-unavailable shape, never zero or a fabricated fallback.
- Only one deterministic pack image and one deterministic top-chase image reach the read model; raw provider image arrays and provenance stay canonical.

No PostgreSQL schema change is owned by this spec. No Convex user, bookmark, preference, or account table is added for V1; theme remains device-local.

## Interfaces, APIs, and Endpoints

### Stable application result

```ts
type PublicReadErrorCode =
  | "INVALID_QUERY"
  | "CURSOR_EXPIRED"
  | "SNAPSHOT_UNAVAILABLE"
  | "PACK_NOT_FOUND";

type PublicResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: PublicReadErrorCode;
      readonly retryable: boolean;
    };

type PublicValue<T, Reason extends string> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: Reason };
```

Convex public queries return this union for known application outcomes. Invalid query input is an `ok: false` application result even when the Convex transport itself succeeded; route components never infer validation state from HTTP status. Network, server-preload, subscription, and runtime failures occur outside a successful handler result and therefore are not fabricated as an application code.

### Public query inputs and outputs

| Query | Input | Successful data |
|---|---|---|
| `getPublicShellStatus` | none | Sanitized snapshot status and exact completed/data-as-of/last-successful-observation times |
| `getDashboardBundle` | normalized filters plus optional selected public pack ID | Four KPIs, six opportunities, contextual facets, two summaries, selected detail, metadata |
| `listPublicPacks` | normalized query, facets, price state, sort, direction, cursor envelope, page size | Up to 50 rows, initial selected detail, Previous/Next state, range, contextual facets, metadata |
| `getPublicPack` | public pack ID plus snapshot ID | One detail bound to that snapshot or `PACK_NOT_FOUND` |

The UI requests 25 rows; the boundary accepts 1–50. Search is at most 120 normalized characters. Price values are USD minor units from 1,000 through 1,200,000 when explicitly constrained. Unknown facets, duplicate-inconsistent parameters, inverted ranges, unsupported sorts, malformed cursor stacks, and oversized state return `INVALID_QUERY` without partially applying valid fragments. A well-formed cursor for a snapshot no longer retained returns `CURSOR_EXPIRED` and a reset-to-first-page action.

### Snapshot status contract

A complete snapshot is `fresh` when `catalogState.lastSuccessfulObservationAt` is at most 15 minutes old and no source is delayed. It is `delayed` when the observation age exceeds 15 minutes or `delayedSourceCount` is greater than zero. A metadata-only unchanged observation advances this freshness clock without changing the active snapshot ID/content. With no active completed snapshot, the query returns `SNAPSHOT_UNAVAILABLE`; it never returns zero KPIs or sample packs.

## Data Flow

### Publication to initial paint

1. `tech-001` assembles one committed canonical snapshot/observation ledger result; `tech-002` is the only publisher that writes it to Convex.
2. Publication reconciliation activates the immutable snapshot atomically, or refreshes only observation metadata for unchanged content; incomplete staged rows remain unreadable.
3. The Next server page normalizes its URL and executes its single composite `preloadQuery`.
4. The route client hydrates the typed result with `usePreloadedQuery` inside the shared Convex provider.
5. The page renders shell status and route data from the same snapshot ID.

### Interaction and reactive replacement

1. Draft filters remain local until Apply; accepted state is serialized once and pagination returns to the first page.
2. The client navigates to the canonical accepted URL in a transition; the server issues that surface's one replacement preload while accepted content remains visible.
3. A successful result replaces rows, aggregates, facets, and eligible selection together.
4. A publication change resets cursor state to page one while preserving filters and any still-eligible selection.
5. A failed result keeps accepted content visible and maps only approved error copy near the initiating control.

## Error Handling and Edge Cases

| Cause | Stable handling |
|---|---|
| No active completed snapshot | `SNAPSHOT_UNAVAILABLE`; Dashboard shows Retry while Learn remains available |
| Malformed URL, cursor, filter, range, sort, or page size | `INVALID_QUERY`; reject the whole state and offer Reset catalog |
| Snapshot changes while a later page is open | Return page one with `paginationReset: "snapshot_changed"`; clear cursor URL state coherently |
| Cursor names a valid snapshot that retention already removed | `CURSOR_EXPIRED`; preserve accepted filters and reset to the current first page |

### Selection and read failures

| Cause | Stable handling |
|---|---|
| Unknown or removed selected pack | `PACK_NOT_FOUND` for direct detail; route selection falls back to the first eligible visible pack |
| Convex read failure after accepted content exists | `CatalogReadBoundary` retains its last accepted result and shows stable local retry feedback; no handler code is invented |
| Server preload/read failure with no accepted cache | Route `error.tsx` renders stable Retry recovery and no rows, sample metrics, transport text, or internal identifiers |

An empty catalog, a valid no-match query, an unavailable field, and a failed query are distinct successful/error outcomes. Disabled packs never publish; sold-out packs remain in All Packs but stay out of Overview opportunities. Missing price remains visible only in the full price state, and all unavailable sortable values remain last in either direction.

## Testing and Verification

### Contract and query tests

- Add `packages/contracts/src/public-catalog.test.ts` after PR #1 merges for result-union, value-unavailable, normalization, metric, and serialization examples.
- Add `convex/publicCatalog.test.ts` using the test approach required by the generated Convex guidance.
- Cover coherent Overview reads, contextual facet counts, sold-out/disabled handling, unavailable-last sorting, and full-versus-narrowed price behavior.
- Cover all `packscout_relevance_v1` tiers without metric reordering and cursor binding to snapshot plus normalized query fingerprint.
- Cover missing snapshot, malformed state, page reset after activation, unknown pack, and retained previous snapshot.

### Frontend tests

- Add `apps/frontend/lib/catalog-query-state.client.test.ts` for canonical URLs, cursor-stack navigation, browser history, and reset behavior.
- Add `apps/frontend/lib/metric-presentation.test.ts` for integer-minor-unit EV $, signed EV %, buyback wording, and unavailable states.
- Add `apps/frontend/lib/learn-content.test.ts` for the exact three records, order, stable slugs, glossary reuse, and unknown slugs.
- Add focused route/component behavior tests for one preload per surface, reactive hydration, retained accepted content, selection recovery, and stable public copy.
- Add direct recovery tests for failed server preload, failed client subscription, cached-content retention, no-cache route fallback, Retry, and recovery without inventing an application result for transport failure.

Map these files back to `.tasks/repack-dashboard/scenarios/repack-dashboard.feature.md` before implementation handoff.

Run `npm run test:frontend`, `npm run lint:frontend`, `npm run typecheck:frontend`, `npm run build:frontend`, and `npm run check:boundaries` while implementing. The full `npm run verify:framework` gate remains mandatory; scale, browser, accessibility, and launch evidence are specified in `repack-dashboard/tech-004`.

## Open Questions and Risks

No product or architecture questions remain for this slice.

- Generated Convex guidance does not exist yet; initialization and complete guidance review are a hard implementation prerequisite.
- Compact shard rows can still exceed transaction bytes if projection fields grow; the 48 KiB/96-row shard bounds and 10,000-pack real-backend gate fail acceptance rather than returning partial results.
- A reactive snapshot can invalidate opaque pagination; snapshot-bound fingerprints and atomic page-one reset prevent mixed-snapshot results.
- Next server preload APIs can change with the installed Convex version; generated types and guidance, not memorized signatures, are authoritative.
- Public image or action data can drift from approval configuration; publication omits mismatches instead of letting the UI repair them.

## Handoff Notes

1. Complete `repack-dashboard/tech-001` and `repack-dashboard/tech-002`, then initialize Convex and read its generated guidance.
2. Land public contracts and result-union tests before implementing schema or route components.
3. Prove active-snapshot, search, sort, facet, price, and cursor behavior against fixtures before styling the UI.
4. Add one-preload route hydration and local Learn content, then add reactive accepted-state replacement.
5. Hand security, actions, telemetry, performance, accessibility, and launch evidence to `repack-dashboard/tech-004`.
