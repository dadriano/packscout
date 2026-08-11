# Task: Serve Public Catalog Exploration

**ID:** repack-dashboard/003
**Depends on:** repack-dashboard/002
**Blocks:** repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including contract and failure-path verification
**Status:** blocked

## Start Here

Specify one valid and one invalid request/response example for Overview, All Packs, and pack detail using `CatalogSnapshotV1`.

## Objective

Provide stable public read contracts for the Dashboard Overview, searchable All Packs catalog, and selected-pack detail without exposing persistence, tenant, or provider internals.

## Context

The canonical pipeline currently supports identity lookup and EV explanation, not public list, filter, sort, pagination, or aggregate queries. The frontend needs bounded query behavior over the active catalog snapshot. Public inputs are untrusted and require stable validation and error mapping.

## Requirements

### Overview Read

- Return all four KPI values, the six highest-ranked opportunities, platform summaries, category summaries, active filters, one selected-pack detail, and snapshot metadata in one coherent result.
- Compute Overview counts and rankings from active public packs only.
- Exclude unavailable estimates from positive and median EV calculations while retaining their packs elsewhere.
- Return at most five platform summaries and five category summaries, ordered by pack count with a deterministic tie break.
- Use EV $ high to low for opportunity ranking and stable public pack ID as the final tie break.

### Catalog Read

- Accept a text query, multiple platforms, multiple categories, a $10–$12,000 price range, one approved sort, direction, cursor, and page size.
- Default to EV $ high to low and up to 25 rows per page; reject page sizes above 50.
- Use relevance order while a text query is present and ignore metric sort until the search is cleared.
- Return Previous/Next cursor state, result range, active filters, available facets, snapshot metadata, and selected-pack eligibility.
- Include active and sold-out public packs; keep disabled packs absent.

### Cursor and Facet Semantics

- Bind every opaque cursor to the snapshot publication ID, normalized search, accepted facets, price mode, sort, direction, and page size through a query fingerprint.
- Reject a cursor whose snapshot or fingerprint does not match; when a newer snapshot activates, start at its first page while preserving valid filters and eligible selection.
- Treat the default full price state as no price predicate so rows with unavailable USD comparison price remain visible.
- When the user narrows either price bound, exclude unavailable USD comparison prices and apply the range only to canonical USD minor units.
- Return contextual facet counts after search, price, and the opposite facet group are applied while ignoring the facet's own selected group.

### Ordering Semantics

- Materialize supported metric sort values in the public snapshot; queries do not derive Gross EV, signed EV $, or signed EV %.
- Place unavailable values last for ascending and descending metric sorts, then apply stable public pack ID as the final tie break.
- Use normalized Pack name for Pack sorting and stable public pack ID for exact name ties.
- Preserve relevance as the sole order during text search; do not add a hidden metric order.
- Return `CURSOR_EXPIRED` separately from `INVALID_QUERY` so the UI can reset to the first coherent page without applying cursor fragments.

### Input Validation

- Normalize whitespace and casing without changing stable IDs or user-visible names.
- Reject unknown sort values, malformed cursors, inverted prices, out-of-range prices, excessive search length, and invalid filter values.

### Public Error Outcomes

- Map invalid public input to a stable `{ error, code: "INVALID_QUERY" }` application outcome.
- Map missing active data to `SNAPSHOT_UNAVAILABLE` and an unknown public pack to `PACK_NOT_FOUND`.
- Map a no-longer-retained snapshot cursor to `CURSOR_EXPIRED` without exposing the embedded snapshot or query fingerprint.
- Never return partial internal errors, stack traces, provider failure codes, or tenant identifiers.

### Query Reliability

- Read only the active completed snapshot.
- Keep one Overview result internally consistent rather than composing independent point-in-time reads.
- Bound every list and aggregate operation for the supported catalog size.
- Preserve deterministic ordering across pagination when values tie.
- Permit the last complete snapshot to remain readable while publication is delayed.

## User-Facing Behavior

Dashboard content loads without authentication. Invalid URL state produces a safe, recoverable message. Browser back/forward can restore a valid catalog state because every accepted input has a stable serialized form.

## Interface Contract

| Query | Input | Output |
|---|---|---|
| `getDashboardBundle` | filters and selected public pack ID | KPIs, opportunities, summaries, selected detail, metadata |
| `listPublicPacks` | query, filters, sort, direction, cursor, page size | bounded rows, cursors, facets, result range, metadata |
| `getPublicPack` | public pack ID and active snapshot version | pack detail or stable not-found outcome |

Approved metric sorts are Pack, Pack Price, EV $, EV %, Buyback %, Gross EV, and Top Chase Value. Text search matches pack name, platform display name, and category.

Facet counts are navigational counts, not global catalog totals: Platform ignores the accepted Platform group while applying Category/search/price; Category ignores the accepted Category group while applying Platform/search/price. Selected zero-count values remain visible until Apply or Reset changes them.

## Acceptance Criteria

### Happy Paths

- [x] Overview returns one coherent bundle with four KPIs, six opportunities, summaries, detail, and metadata.
- [x] All Packs supports combined search, multi-select facets, price range, deterministic sort, and cursor pagination.
- [x] Text search returns relevance order and restores the previous metric sort after clearing.
- [x] Sold-out packs are labeled in All Packs and excluded from opportunities.
- [x] The same accepted query yields stable ordering when metric values tie.

### Failure and Boundary Paths

- [x] Every invalid input produces the stable public validation error without partial data.
- [x] A missing initial snapshot and an unknown pack have distinct public outcomes.
- [x] Delayed publication returns the last complete snapshot with delayed metadata.
- [x] No public request or response contains an organization selector or internal provider identifier.
- [ ] Representative catalog queries stay within documented row, byte, and latency budgets.

### Cursor, Facet, and Null Evidence

- [x] A cursor cannot cross a snapshot, search, filter, sort, direction, or page-size fingerprint.
- [x] Snapshot activation begins a coherent first page without mixing old and new records.
- [x] The full price state retains price-unavailable rows; narrowing price excludes them.
- [x] Contextual facet counts follow the opposite-group rule and keep selected zero-count values visible.
- [x] Unavailable sort values are last in both directions with deterministic ties.

## Build Status

- Implemented: strict public result unions and query inputs; four bounded Convex read queries; coherent Overview aggregation; deterministic relevance, filters, contextual facets, null-last sorts, query-bound cursors, snapshot reset/expiry handling, and snapshot-bound detail; canonical URL parsing/serialization and server route normalization.
- Verified: public contract tests, nine `convex-test` read-model scenarios, frontend URL-state/table tests, generated Convex types, and local route integration all recorded green.
- Blocked: task `002` has no activated cloud snapshot. Route data currently uses a server `fetchQuery`/explicit development fixture boundary rather than the required cloud-backed one-composite `preloadQuery` plus reactive `usePreloadedQuery`; representative cloud row/byte/latency budgets are also unmeasured.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-005
- Alignment: local query contracts and Convex functions implement the specified validation, active-snapshot coherence, search, facets, price, ordering, cursor, selection, and sanitized application outcomes.
- Divergences: the temporary server `fetchQuery` integration is non-reactive and intentionally does not claim the spec's preload/subscription contract; it must be replaced after a real cloud publication boundary exists.
- Verification: contracts tests, `npm run test:convex`, frontend query-state tests, typecheck/lint/build, and browser-loaded local fixture routes recorded green; live Convex scale and reactive replacement remain unverified.
