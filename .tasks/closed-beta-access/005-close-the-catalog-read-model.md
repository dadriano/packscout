# Task: Close the Catalog Read Model to Unadmitted Callers

**ID:** closed-beta-access/005
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/011
**Estimated scope:** large
**Status:** done

## Objective

While the closed beta is on, catalog data is served only to admitted product identities and to PackScout's own server-side rendering path — not to anyone who knows the backend's address.

## Context

PackScout's catalog reads are unauthenticated by design: the site renders its pages on the server by reading the public read model with no credential at all, and the backend's address is a public value shipped to browsers. That was correct for a public product. For a closed beta it is the hole in the wall — pages can require sign-in while the same data stays freely queryable by anyone who reads the page source.

So the read model gets two admitted callers instead of one open door: an authenticated product identity that is admitted, and PackScout's own server rendering path presenting a server-held credential. The credential authorizes the *server*, not the visitor — deciding which visitors get a rendered page stays with closed-beta-access/007, and this task must not become a way to serve gated data to someone the gate would have turned away.

This is the largest change in the feature because the read surface has several entry points — listings, aggregates, detail reads, collectible search — and closing all but one of them is the same as closing none. Enumeration is part of the work.

## Requirements

- While the beta is on, every catalog read requires either an authenticated identity whose effective access is admitted, or PackScout's own server-side rendering path presenting a server-held credential. Every other caller is refused.
- The server-held credential is server-side configuration only: never in a browser bundle, page source, client-visible configuration, response body, error payload, or log. It follows the project's existing rules for server-held secrets.
- Refusals are stable and non-leaking: they reveal nothing about whether particular data exists, carry no catalog fields, and expose no internal error detail.
- Operational and lifecycle reads that must stay reachable, stay reachable: liveness and health probes, and the unauthenticated gate-status read from closed-beta-access/001 that the signed-out landing experience depends on.
- Every catalog entry point is covered. The task enumerates the read surface — listings, dashboard bundles, detail reads, aggregates, search — and a test proves that no catalog read path remains reachable without one of the two admitted callers while the beta is on. A newly added read path that skips the gate must fail that test.
- With the beta switch off, catalog reads are public again exactly as they are today, with no credential required and no behavior change.
- A missing or misconfigured credential degrades the site to its existing bounded "temporarily unavailable" state rather than crashing the server, rendering a blank page, or falling back to serving data.
- The server rendering path's own reads are updated to present the credential, and its existing failure handling continues to produce the same bounded, user-visible unavailable states it produces today.
- Per-request cost stays bounded: closing the read model must not add an unbounded number of extra round trips per rendered page.

## User-Facing Behavior

Nothing changes for an admitted user browsing the product. A stranger who points a client at the backend gets a refusal instead of the catalog. If the credential is missing or wrong in a deployment, visitors see the product's existing "data temporarily unavailable" state instead of a broken page.

## Interface Contract

- Catalog reads accept exactly two kinds of caller while the beta is on: an admitted authenticated identity (via the effective-access resolution from closed-beta-access/001) and the server rendering path presenting the server-held credential.
- The credential is supplied to the rendering path as server-side configuration; its absence produces the existing unavailable result rather than an exception.
- The gate-status read and health probes remain unauthenticated.
- Visitor-level gating is explicitly *not* provided here; closed-beta-access/007 owns it.

## Acceptance Criteria

- [x] Every catalog read refuses anonymous and unadmitted callers while the beta is on, and succeeds for an admitted identity and for the server credential.
- [x] An enumeration test proves no catalog read path is reachable without one of the two admitted callers while the beta is on.
- [x] The gate-status read and health probes remain reachable unauthenticated.
- [x] No refusal payload, response header, log line, or browser-delivered asset contains the credential or catalog content.
- [x] With the switch off, catalog reads are public exactly as today.
- [x] With the credential missing or invalid, rendered pages show the existing bounded unavailable state rather than crashing or serving data.

## Verification

Product backend tests prove refusal and acceptance per caller kind for every enumerated catalog read, the enumeration test that no read path is left open, unauthenticated reachability of gate-status and health, both switch positions, and non-leaking refusal payloads. Frontend server-read tests prove the rendering path renders with the credential present and degrades to the existing unavailable state without it. The workspace typecheck, the product-backend test command, and the frontend test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` ("the data API is closed, not just the UI"; three-door enforcement); closed-beta-access/001 (effective access and gate status — consumed via `resolveProductUserEffectiveAccess`, never re-derived); closed-beta-access/007 boundary (visitor gating and the identity cookie stay there; the credential here authorizes the *server*, and no part of this task serves data to a visitor 007 would turn away); closed-beta-access/004 boundary (admission on the authenticated saved-items capability belongs there).
- Enumerated read surface (source-scanned, not hand-listed — every public `query` registration in `convex/`, dispositioned):
  - `publicRepacks.getPublicShellStatus` — **closed** (release metadata for the shell).
  - `publicRepacks.getDashboardBundle` — **closed** (dashboard bundle: KPIs, opportunities, details, facets).
  - `publicRepacks.listPublicRepacks` — **closed** (listings, pagination, desired-collectible narrowing).
  - `publicRepacks.getPublicRepack` — **closed** (detail read).
  - `publicRepacks.searchPublicCollectibles` — **closed** (collectible search).
  - `publicRepacks.findRepacksByDesiredCollectible` — **closed** (desired-collectible matches).
  - `productUserAccess.getGateStatus` — **open by design**: the anonymous beta on/off read the signed-out landing depends on (001); no identity, counts, or catalog data.
  - `productUserAccess.getMyAccess` — **open by design**: authenticated self effective-access read (001); refuses anonymous callers, catalog-free.
  - `productUsers.getMyStanding` — **open by design**: authenticated self standing read; refuses anonymous callers, catalog-free.
  - `savedItems.getSavedItemIds` — **open by design here**: authenticated capability returning only the caller's own references; its admission enforcement is closed-beta-access/004.
  - `publicRepackAggregates`, `publicRepackValidation`, `publicCatalogManifestReadModel`, `publicCatalogHeatReadModel`, `publicCatalogPagination`, `publicProviderCatalogReadModel`, `repackHeatReadModel`, `mockDataReleaseSearch`/`dataRelease*` — helper modules registering no public functions; reachable only through the six gated queries above.
  - `convex/http.ts` audited, not edited: every route is POST and authenticated (admin directory token or production publication keys); the saved-items route returns catalog-joined data only behind `PACKSCOUT_ADMIN_DIRECTORY_TOKEN`. No unauthenticated catalog data on the HTTP router, and no health route exists there; liveness probes are the platform's and the frontend's (`/api/health`, 007), both untouched.
- Mechanism: `convex/publicCatalogReadAccess.ts` owns the two-caller check (`catalogReadAuthorized`): while `PACKSCOUT_CLOSED_BETA=1`, a read is served only to (a) an authenticated identity whose effective access is admitted — resolved inside the same query transaction via 001's `resolveProductUserEffectiveAccess`, one indexed read, no extra round trip — or (b) the server rendering path presenting the deployment credential. Every other caller gets `publicReadError("RELEASE_UNAVAILABLE")` — byte-identical to "no release is active", so a refusal reveals nothing about data existence and carries no catalog fields or internal detail. The gate runs first in every handler (authenticate/authorize before validate, per the engineering rules), and nothing on the refusal path throws, logs, or echoes anything caller-derived.
- Credential: `PACKSCOUT_CATALOG_READ_TOKEN`, the same name on both ends. Convex side: declared in `convex.config.ts`, read at request time through the established deployment-configuration cast, trimmed, honored only at 32–512 chars, compared with the length-then-constant-time shape used for `PACKSCOUT_ADMIN_DIRECTORY_TOKEN`; absent/short/long configuration authorizes nobody (fail closed). Frontend side: `lib/public-repacks.server.ts` (server-only module) reads the non-`NEXT_PUBLIC_` variable with the same bounds, and `catalogReadArguments` attaches it to each of the six existing `fetchQuery` calls — the credential rides existing round trips as an optional query argument (arguments from server code never reach browsers), so per-page cost is unchanged. Out-of-bounds or missing configuration sends nothing, which degrades to the existing `RELEASE_UNAVAILABLE` states rather than crashing; the value is never logged and never part of any result. A post-build scan shows neither the variable name nor `catalogReadToken` in any `static/` (browser-delivered) asset.
- Enumeration test: `convex/publicCatalogReadAccess.test.ts` raw-globs every non-generated, non-test `convex/*.ts` source, discovers every `export const … = query({…})` (and fails on any default-exported registration), and asserts the discovered set equals gated ∪ documented-open exactly — so a newly added public query fails the build until it is gated or consciously classified. The refusal matrix is keyed by the same enumerated names (key-set asserted), and per gated read proves: served with the switch off; refused for anonymous, wrong-credential, and awaiting-review callers with the switch on; served for the deployment credential and for an admitted identity. Verified live that an unclassified probe query trips the suite.
- Both switch positions: with the switch off the gate short-circuits before any credential or identity logic — catalog reads are public exactly as today (the pre-existing `publicEightProviderCertification` suite runs them credential-free and is untouched and green), a stray credential changes nothing, and existing frontend callers' argument shapes stay valid because the new argument is optional.
- Local lane: with `PACKSCOUT_CLOSED_BETA=1` and no credential, the 5197 preview's product face correctly shows the bounded unavailable states. For a full local demo, `scripts/local/seed-convex-mock-data-release.mjs` now mirrors a bounded `PACKSCOUT_CATALOG_READ_TOKEN` from the root `.env.local` onto the asserted anonymous/local deployment (value never printed; unset means no write), and the frontend dev session inherits the same value; documented in `README.md` ("Closed-beta catalog read credential") alongside the operator provisioning steps for real deployments.
- Divergences: (1) Refusals reuse the existing `RELEASE_UNAVAILABLE` vocabulary instead of adding an access-specific code — a distinct code would leak that data exists behind a gate, and the existing code is what every frontend surface already renders as its bounded unavailable state. (2) The credential argument is validated as `v.optional(v.any())`, matching the module's argument convention, so a malformed value from a stranger is refused in-band rather than surfacing a validator exception. (3) The constant-time comparison is a module-local copy of the shape in `http.ts` rather than an import, because that helper is deliberately private there and `http.ts` is outside this task's write scope. (4) No Convex-side health read exists to keep open; the "health probes stay reachable" criterion is carried by the platform liveness surface and 007's `/api/health`, with the gate-status read proven reachable by test. (5) `repackHeatReadModel.ts` and `mockDataReleaseSearch.ts`, named in the working brief as read-surface files, register no public functions — they are closed by having no entry point, and the enumeration test is what keeps that true.
- Verification: `npm run typecheck:convex && npm run test:convex` → exit 0 (28 files, 251 tests; 13 in `convex/publicCatalogReadAccess.test.ts`). `npm run lint:frontend && npm run typecheck:frontend && npm run test:frontend` → exit 0 (276 tests; `lib/public-repacks.server.test.ts` grew from 1 to 5, covering credential bounds, per-read attachment, non-mutation, and bounded degradation with no backend and with an unreachable backend). `npm run build:frontend` → exit 0 (all routes dynamic, unchanged set). `npm run scan:framework-standards:ratchet` → 0 findings, 0 new. `node scripts/check-docs.mjs` → ok (156 files). Tooling lane (`scripts/local` changes) → 206 pass, 0 fail; the two `start-admin-embedded` isolated failures pre-exist on a clean tree and are unrelated.
