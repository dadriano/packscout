# Task: Close the Catalog Read Model to Unadmitted Callers

**ID:** closed-beta-access/005
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/011
**Estimated scope:** large
**Status:** todo

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

- [ ] Every catalog read refuses anonymous and unadmitted callers while the beta is on, and succeeds for an admitted identity and for the server credential.
- [ ] An enumeration test proves no catalog read path is reachable without one of the two admitted callers while the beta is on.
- [ ] The gate-status read and health probes remain reachable unauthenticated.
- [ ] No refusal payload, response header, log line, or browser-delivered asset contains the credential or catalog content.
- [ ] With the switch off, catalog reads are public exactly as today.
- [ ] With the credential missing or invalid, rendered pages show the existing bounded unavailable state rather than crashing or serving data.

## Verification

Product backend tests prove refusal and acceptance per caller kind for every enumerated catalog read, the enumeration test that no read path is left open, unauthenticated reachability of gate-status and health, both switch positions, and non-leaking refusal payloads. Frontend server-read tests prove the rendering path renders with the credential present and degrades to the existing unavailable state without it. The workspace typecheck, the product-backend test command, and the frontend test command exit 0.
