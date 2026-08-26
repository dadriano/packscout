# Task: Expose Published Provider Catalog Reads from the Product Backend

**ID:** provider-data-inspection/004
**Depends on:** none
**Blocks:** provider-data-inspection/005, provider-data-inspection/006, provider-data-inspection/007, provider-data-inspection/008
**Estimated scope:** medium
**Status:** done

## Objective

The admin server can read, for any provider, which catalog release the product backend currently serves and what is inside it — release identity and counts, paged entity listings, single documents by public ID, and identity-only ID pages for reconciliation — through an authenticated server-to-server surface that no browser can reach.

## Context

The product backend (Convex) holds a versioned, published read model, and since the promotion work it is organized per provider. The relevant shape:

- `providerCatalogReleases` is one row per published provider release, keyed by `platformKey` and `publicProviderReleaseId`, carrying `lifecycle` (`staging`, `complete`, `failed`, `retired`), `dataAsOf`, `providerReleaseFingerprint`, `contentHash`, `entityHashes`, `counts`, `batchCount`, `batchChainHash`, and completion metadata.
- The published entities hang off a release: `providerCatalogVendors`, `providerCatalogCategories`, `providerCatalogRepacks`, `providerCatalogCollectibles`, `providerCatalogRepackChases`, and `providerCatalogSearchShards`, each indexed by release plus public entity ID.
- `activeCatalogManifestState` and `catalogManifestProviderReferences` decide which provider release is actually live; a provider can be configured in PostgreSQL and absent from the active manifest.
- `providerCatalogPublications` and the reconciliation tables record what a publication expected versus accepted.

These are internal tables. No browser or product client may read them. The repository already has the pattern for privileged admin reads: a POST-only server-to-server HTTP surface on the backend that authenticates the caller against a deployment secret before running internal functions, exposes stable error codes, and never lets an upstream body escape into a response. The product-user directory integration is built exactly this way, and this task follows it rather than inventing a second mechanism.

Backend queries are bounded — a single query cannot return millions of rows. Every listing here is cursor-paged with a server-enforced page size, and the identity-only ID page exists precisely so task 007 can walk a large release without pulling document bodies.

## Requirements

- A per-platform active-release read returning: whether the active manifest currently selects a release for that `platformKey` at all, and if it does, the `publicProviderReleaseId`, `lifecycle`, `providerReleaseFingerprint`, `contentHash`, `entityHashes`, `counts`, `dataAsOf`, and completion metadata. A platform absent from the active manifest is a normal, representable answer — not an error.
- A cursor-paged entity listing for a given release and entity kind, with a stable total order, opaque cursors, and a page size bounded server-side within the backend's per-query limits.
- A single-document read by release plus public entity ID, returning the stored document, and a representable "not present in this release" answer.
- A cursor-paged, identity-only listing of public entity IDs for a release and entity kind — no document bodies — sized so a reconciliation walk can cover a large release in a bounded number of requests.
- The surface is reachable only server-to-server: authenticated against the deployment secret before any work begins, with no browser-facing access, no client-supplied claim, and no committed token. The secret is read from server configuration and never appears in a response, a log line, or a browser bundle.
- Every request is validated. Failures collapse into a small set of stable, documented codes; no upstream body, internal document, or backend error text propagates to the caller.
- Every operation is a read. Nothing on this surface mutates a release, a manifest, or a publication record.
- Reads must tolerate a release in any lifecycle state, and must say which state they read rather than treating `staging`, `failed`, or `retired` as if it were `complete`.

## User-Facing Behavior

None directly — this is the boundary behind tasks 005, 006, 007, and 008.

## Interface Contract

- The admin server is the only caller. It addresses every read by `platformKey`, the same stable provider identity PostgreSQL uses in `provider_sources.platform_key`, so task 006 can join the two sides without a translation table.
- Task 005 consumes the active-release read, the entity listing, and the single-document read. Task 006 consumes the active-release read for fingerprints, counts, and `dataAsOf`. Task 007 consumes the identity-only ID page. Task 008 consumes the single-document read.
- The active-release response distinguishes three cases the callers must be able to tell apart: no active manifest at all, an active manifest that does not reference this platform, and an active manifest that references a release. Collapsing these into one "nothing" answer breaks task 006's verdicts.
- Entity kinds are named consistently across the listing, ID-page, and single-document reads so callers use one vocabulary.

## Acceptance Criteria

- [x] An authenticated server-to-server call returns the active release for a platform that has one, and returns the distinct "not referenced by the active manifest" answer for one that does not.
- [x] An unauthenticated call, a call with a malformed or short token, and a browser-style cross-origin call are each refused, and none of them performs work.
- [x] Paging an entity listing with a cursor visits every entity in the release exactly once under a stable order, and the server enforces its own maximum page size regardless of what the caller asks for.
- [x] The identity-only ID page returns public IDs without document bodies and pages to completion over a release larger than one page.
- [x] A single-document read returns the document when present and the distinct not-present answer when absent.
- [x] Errors carry only stable codes; no upstream body, document content, or backend error text appears in any error response.
- [x] A release in `staging`, `failed`, or `retired` reads with its actual lifecycle rather than being reported as complete.

## Verification

Backend tests prove the authentication gate refuses unauthenticated, malformed-token, and browser-origin callers without performing work; that pagination is stable, complete, and server-bounded across both the entity listing and the ID page; that an absent platform and an absent document are representable answers rather than errors; and that no error response carries an upstream body. The backend test suite and its typecheck exit 0.

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented as specified. The active-release read, the paged entity listing, the identity-only ID page, and the single-document read are all internal queries behind the existing deployment-secret guard in the product backend's server-to-server router. Every one is a query, so no path here can write. The three absences the contract requires stay distinguishable, and a release reports its own lifecycle rather than being presented as complete.
- Additional case found: a manifest can reference a release the store no longer holds. That is reported as its own `release_missing` status rather than collapsed into "platform not referenced", because it is an inconsistency an operator needs to see, not an absence.
- Divergences: `repack_chases` carries no standalone public identity — the table is keyed by release plus internal repack and collectible ids. Rather than synthesize a composite identity, chases are compared through the publication's own `providerCatalogRepackReconciliation` record (expected versus accepted chase counts per repack), exposed as a fifth read. Identity paging therefore covers the four kinds that do have public ids: vendors, categories, repacks, collectibles. Task 007 must reconcile chases through their parent repack.
- Generated artifact: `convex/_generated/api.d.ts` was hand-edited to register the new module, because codegen requires a live deployment that is not available offline. The edit is exactly what codegen emits — one import and one module-map entry in alphabetical position — and the next codegen run reproduces it.
- Verification: `npm run test:convex` (292 pass across 31 files, including 11 new tests proving the auth gate refuses unauthenticated, short-token, and wrong-token callers without doing work; that identity paging visits every id exactly once across a multi-page walk; that the server caps a caller's requested page size; and that an unknown release and an absent document are representable answers rather than errors), `npm run typecheck` (0 errors), `npm run lint` (clean), `npm run scan:framework-standards:ratchet` (0 new findings).
