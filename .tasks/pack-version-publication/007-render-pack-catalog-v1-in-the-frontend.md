# Task: Render Pack Catalog V1 in the Frontend

**ID:** pack-version-publication/007
**Depends on:** pack-version-publication/005, pack-version-publication/011, pack-version-publication/012
**Blocks:** pack-version-publication/008
**Delivery phase:** P07
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder after dependencies are complete, including browser, accessibility, query-state, and saved-item verification
**Status:** todo

## Active build — 2026-09-04

The measured14-file loader/save foundation is owned by task012/P07A in `.worktrees/pack-version-publication-p07-frontend`, branch `codex/pack-version-publication-p07a-frontend-foundation`, PR120 on mainf6785251. Current runtime35ef3d75 has48 focused tests and its request-ID review fix verified; current full gate is pending. Task007 remains todo: all visible catalog routes switch atomically after011 full-data coverage and012 verification/merge. The user authorizes building the remaining phases when dependencies are ready. No operation-by-operation coexistence, old-DTO adapter, cutover or task007 PR exists.

## Historical handoff before the all-tasks request

Not started. P05/PR108 is merged, so its dependency is now available, but starting 007 is outside the current 002/003 repair authorization. Other frontend/Watchlist PRs are not completion evidence for this task. Preserve all six journeys, stable IDs and saves, complete lifecycle contents, direct V1 reads, and no Heat. Use P05's merged provider-profile joins, title-plus-alias pack search, and exact membership discovery. Keep frontend independent of admin and server implementations; do not introduce an alternate read path.

Shared resume instructions: [_handoff.md](_handoff.md). This is a status/context update, not authorization to begin a later phase.

## Start Here

### Parallel implementation brief after prerequisites merge

Run independently of006 after011 and012 are verified/merged. Own frontend pages and shell/status consumers, API read bridges, catalog/Watchlist components, native view helpers, query-state/cursor recovery and telemetry. Preserve012's authoritative auth/save coordinator; consume011's six actual query schemas and bounded native owner-Watchlist resolver directly without DTO conversion. Do not change publisher/recovery services or worker composition.

Root freezes and serializes shared contracts, exports, Convex schema/validators/generated API and any public-store corrections before delegation. Coordinate the native owner-saved resolver with the visible Watchlist switch atomically; prove006 has no old-contract imports before deleting any shared old files. Verify all six journeys in real desktop/narrow/keyboard browser flows, cursor expiry, saves and pack-head advances, plus the594-test frontend predecessor baseline and full framework gate.

Measure early: the read-only audit found34 non-test frontend files referring to old release/read/status identity before additional query-state/Watchlist tests. This is a review-size warning, not permission to introduce adapters, split an unsafe visible cutover, add phases or exceed the hard stop silently. Retain every frontend data point and no Heat.

Map the six catalog journeys to one `pack_catalog_v1` fixture, then record the expected URL, saved identity, query state, focus state, and rendered result for success, empty, and structured-error outcomes.

## Objective

User clarification on 2026-09-04: support every data point currently used by the frontend. Task011/P05A supplies the necessary native V1 contract, snapshot, read, and Watchlist corrections before the visible switch. Independent native loader/state work may proceed while that contract is finalized.

Render the complete public catalog directly from `pack_catalog_v1` while preserving stable identities, URLs, saves, and user query intent for every supported journey.

## Context

Each catalog pack is an immutable snapshot selected by that pack’s active head. The browser must treat the snapshot named by the response as one coherent unit so price, contents, odds, chase, valuation, actions, and EV never come from different pack snapshots.

The public experience has six journeys: catalog shell status, dashboard, pack listing, pack detail, collectible search, and packs containing a desired collectible. They share stable public identities and query-state rules, but each must retain complete loading, empty, unavailable, and error behavior.

## Delivery Context

P07 starts after P05 and is a frontend-only PR. Its review promise is one browser-safe catalog experience that consumes the sole public V1 contract directly. After merge, publication schedules, operator commands, and public launch authorization remain unchanged; P08 consumes the completed journeys for operational readiness checks.

## Requirements

### Catalog journeys and coherence

- Implement shell status, dashboard, pack listing, pack detail, collectible search, and desired-collectible pack matching directly against `pack_catalog_v1`.
- Resolve every rendered pack summary, detail, membership row, odds value, chase, valuation, action, and EV value from the same `publicPackSnapshotId`.
- Render provider-wide fields from the current provider-profile snapshot and standalone collectible results from the current collectible-profile snapshot while preserving each pack's sealed display and economic fields; treat a missing required active profile as a bounded invariant error for only the dependent result.
- Treat a missing pack head as absence for only that pack and present a bounded catalog-unavailable state for a failed public request.
- Keep browser code independent from server implementations and exclude credentials, raw records, and protected source evidence from browser data.

### Identity, URLs, saves, and query state

- Preserve `publicRepackId` and `publicCollectibleId` in routes, selected state, saved items, analytics inputs, and action requests.
- Preserve accepted search text, lifecycle filters, sorting, direction, page size, desired-collectible intent, and every still-resolvable stable selection across navigation and re-fetches.
- On `CURSOR_EXPIRED`, clear the cursor, cursor stack, and query fingerprint, then re-fetch the first page exactly once while retaining the accepted query state.
- Prevent repeated cursor recovery loops, malformed canonical URLs, duplicate history entries, and selection loss; clear a selection only after its stable identity returns not found.
- Keep saved-item listing, creation, removal, capacity handling, and detail navigation bound to stable public identities rather than snapshot identities.

### Visibility, actions, and Heat

- Default browse and search to packs whose retirement state is active and whose availability is available.
- Expose every lifecycle and availability state through the explicit all-state view, saved results, and direct links, including unavailable, sold-out, unknown, and retired packs.
- Enable purchase or promotion actions only when a pack is both active and available; render ineligible actions disabled with a clear reason.
- Keep Heat entirely absent from requests, response view models, query parameters, sorting, filtering, analytics, tables, badges, details, tooltips, and visible copy.
- Preserve pack contents, EV, chase, valuation, provider identity, lifecycle, and save controls without inventing missing values.

### Accessible states and bounded behavior

- Provide distinct, bounded loading, empty, unavailable, invalid-query, not-found, authentication, authorization, and recovery states for all six journeys.
- Preserve keyboard navigation, visible focus, semantic headings and tables, accessible names, status announcements, and logical focus movement after paging or recovery.
- Keep layouts usable at narrow and wide viewports without hiding lifecycle, action eligibility, or recovery information.
- Surface stable structured error copy without raw payloads, internal identifiers, stack traces, or repeated automatic requests.
- Bound rendered result counts, detail membership pages, cursor history, and client-side retained state to the public contract’s declared limits.

## User-Facing Behavior

Users can browse the available catalog, open packs, search collectibles, find packs containing a desired collectible, and manage saves through stable URLs. Explicit all-state views, saves, and direct links show unavailable, sold-out, unknown, and retired items with ineligible actions disabled. An expired cursor causes one query-preserving first-page re-fetch rather than an error page. Heat does not appear anywhere in the catalog.

## Interface Contract

The frontend consumes `getPublicShellStatus`, `getDashboardBundle`, `listPublicPacks`, `getPublicPack`, `searchPublicCollectibles`, and `findPacksByDesiredCollectible` from `pack_catalog_v1`.

Saved state consumes authenticated `getSavedItemIds`, `setSavedRepack`, and `setSavedCollectible` from `SavedCatalogItemsV1`. The browser sends only the stable resource identity and desired boolean, consumes `{ saved, prunedUnavailable }`, and maps only the declared bounded error codes; it never supplies an owner or snapshot identity.

The browser-facing view contract carries stable pack and collectible identities, `publicPackSnapshotId`, profile identities, lifecycle, availability, summary or detail data, action eligibility, saved state, bounded page metadata, and structured errors. It contains no Heat field or global catalog release identity.

Query state contains accepted filters and sorting plus an optional signed cursor and bounded cursor stack. `CURSOR_EXPIRED` produces a single first-page re-fetch result with the accepted query state and stable selection preserved when still resolvable.

## Acceptance Criteria

### Journey and identity behavior

- [ ] All six journeys render from `pack_catalog_v1` with each pack bound to one `publicPackSnapshotId`.
- [ ] Pack and collectible routes, saves, selected state, and analytics retain stable public identities across snapshot updates and per-pack rollback.
- [ ] Default browse and search show only retirement-active plus availability-available packs; all-state, saved, and direct-link journeys expose every required lifecycle state.
- [ ] Purchase and promotion actions are enabled only for active and available packs.
- [ ] Heat is absent from browser requests, view contracts, query state, rendered output, and analytics.

### Recovery and accessibility

- [ ] `CURSOR_EXPIRED` triggers exactly one first-page re-fetch without losing accepted query state, resolvable selection, saves, or URL validity.
- [ ] Loading, empty, unavailable, invalid-query, not-found, authentication, authorization, and recovery states are distinct and bounded.
- [ ] Desktop and narrow layouts preserve complete information, keyboard access, visible focus, accessible names, and status announcements.
- [ ] Failed requests expose no credential, protected source evidence, raw record, internal topology, or stack trace.
- [ ] Browser code imports no server implementation and respects all response, page, and retained-state bounds.

### Saved items

- [ ] Pack and collectible saves call only the three named authenticated operations with stable public identities and preserve both independent 250-item bounds.
- [ ] Idempotent save/remove, stale removal, capacity pruning, capacity refusal, invalid identity, missing head, and signed-out behavior render the declared result or error without optimistic-state drift.
- [ ] A `prunedUnavailable` success reconciles the bounded saved-ID set before the affected journey renders again.

## Verification

Named scenario: **Six-journey V1 frontend acceptance** — drive every journey through available, unavailable, sold-out, unknown, retired, saved, deep-link, expired-cursor, empty, unauthorized, and failed-request states at desktop and narrow widths with keyboard-only interaction.
