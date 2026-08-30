# Task: Serve the Frontend from Active Provider Gates

**ID:** distributed-canonical-warehouse/016
**Depends on:** distributed-canonical-warehouse/015
**Blocks:** distributed-canonical-warehouse/019, distributed-canonical-warehouse/020
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including public contract parity, aliases, saved identities, and frontend verification
**Status:** not started

## Start Here

Capture the current public repack list, detail, search, desired-collectible, and saved-item contract fixtures, then map each stable field to an active provider entry or its pinned catalog version.

## Objective

Serve one coherent frontend catalog from independently active provider gates while preserving current public DTOs, search behavior, unavailable-value semantics, and saved public identities.

## Context

Convex is a versioned frontend read model, not an ingestion or operational database. Every public query resolves the active manifest first and reads only artifacts selected by that manifest. Provider database availability does not affect already-published Convex reads.

`publicCollectibleId` is the global collectible UUID and survives merges through aliases. Saved repacks and collectibles remain durable user-owned Convex data outside immutable release artifacts. Heat is deferred; an unavailable Heat wrapper must not block catalog reads or manifest activation.

## Requirements

### Manifest-scoped reads

- Resolve one active manifest revision at the start of every public catalog query and exclude provider releases not selected by it.
- Serve provider/vendor presentation, categories, repacks, collectibles, chase relationships, economics, availability, freshness, media, and approved actions from selected artifacts only.
- Keep one provider entry internally coherent with its pinned catalog version and prevent a response from mixing another version's collectible or category document.
- Continue serving healthy selected providers when another provider has no active entry or its source database is unreachable.
- Preserve explicit unavailable and stale semantics rather than substituting zeroes or current-looking values.

### Public contract parity

- Preserve current listing, search, facets, filters, sorting, detail, desired-collectible matching, and bounded cursor pagination behavior.
- Preserve stable public provider, repack, category, and collectible identities plus current structured public errors.
- Invalidate or reject a stale search cursor when its manifest fingerprint no longer matches the active manifest.
- Preserve current public EV, buyback, odds, availability, content-mode, and freshness contracts without adding Heat as a dependency.
- Keep exact instances, accounts, pulls, events, correlation evidence, credentials, runtime, quarantine, and internal release operations outside public responses.

### Aliases and saved items

- Resolve a retired `publicCollectibleId` through the active catalog alias to one surviving collectible without changing the stored saved ID silently.
- Keep saved repacks and saved collectibles outside release cleanup, reseeding, manifest replacement, and rollback deletion.
- Preserve verified Convex-auth ownership, per-kind capacity, idempotent save and remove, unavailable-save removal, and cross-owner isolation behavior.
- Allow removal of a save even when its entity is not present in the active manifest.
- Reject ambiguous, missing, cross-kind, and duplicate-active public identity states before public activation or save mutation.

### Frontend states

- Preserve loading, empty, filtered-empty, stale, unavailable, not-found, invalid-cursor, saved, capacity, and recoverable failure behavior.
- Show provider data from the active manifest without surfacing internal release or catalog version identifiers to ordinary users.
- Represent unavailable metrics and Heat with explicit text and accessible labels.
- Keep keyboard navigation, focus behavior, labels, responsive layouts, and non-color status meaning intact.
- Keep public reads available without authentication while requiring verified identity for saved-item mutations.

## User-Facing Behavior

A user sees a coherent catalog assembled from the active provider entries. One provider can update without causing another provider to disappear. Saved collectibles survive release updates and collectible merges. Heat may display as unavailable, but repack catalog, search, detail, economics, and saves continue working.

## Interface Contract

Public queries bind to one manifest fingerprint and return the current stable DTOs. Search cursors include enough manifest identity to reject cross-manifest continuation safely. Collectible lookup accepts a public ID, resolves active aliases, and returns one canonical active identity or a stable unavailable or not-found outcome.

Saved-item mutations derive owner identity from verified Convex authentication and accept only the public entity ID and requested saved state. They never accept an owner or release ID from the browser.

## Acceptance Criteria

### Public read acceptance

- [ ] Listing, search, facets, sorting, detail, desired-collectible matching, and cursor pagination read only the active manifest.
- [ ] One provider gate update preserves unrelated provider results and never mixes incompatible catalog versions.
- [ ] Current public DTOs, errors, EV, buyback, odds, availability, freshness, and unavailable-value semantics remain stable.
- [ ] Stale cross-manifest cursors fail safely rather than continuing against mixed data.
- [ ] Protected provider, catalog-governance, runtime, and publication data never enters a public response.

### Identity acceptance

- [ ] Current and retired aliased collectible IDs resolve deterministically to the surviving active collectible.
- [ ] Saved repacks and collectibles survive release activation, rollback, catalog aliasing, and artifact retention cleanup.
- [ ] Save ownership, capacity, idempotency, unavailable-save removal, and unauthenticated failure behavior remain intact.
- [ ] Heat unavailability does not block catalog reads, manifest activation, or saved-item behavior.
- [ ] Frontend loading, empty, stale, unavailable, saved, capacity, and error states remain responsive and accessible.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Public reads resolve the active manifest and its lookup/search projections; Heat remains explicitly unavailable and non-blocking.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
