# Task: Gate the Product Behind Approved Access

**ID:** closed-beta-access/007
**Depends on:** closed-beta-access/001, closed-beta-access/006
**Blocks:** closed-beta-access/008, closed-beta-access/011
**Estimated scope:** large
**Status:** todo

## Objective

Every product surface except the landing page and the operational probes requires an admitted account, decided on the server before anything renders — so unadmitted visitors never receive gated markup, gated data, or a flash of either.

## Context

PackScout's pages are server-rendered with catalog data already embedded, so a browser-side check is not a gate: by the time client code could redirect, the data has already been delivered. The decision has to happen on the server, before render.

That is the hard part, because the product's authentication is currently client-side only — the hosted provider's session lives in the browser and the backend verifies its tokens directly. The server therefore needs its own way to know who the visitor is: the provider issues a server-verifiable identity token, and establishing that server-side signal is part of this task. The builder chooses the mechanism; the requirement is that the server, not the browser, decides.

The approved reference web app's routing model is the template: a small explicit set of public paths, everything else protected, and a separate holding area for signed-in accounts that are not yet approved — with the standing rule that a cached token can be stale, so authoritative checks re-read the real decision rather than trusting what the cookie said at sign-in.

This task owns visitor gating and routing. Closing the backend's own data door is closed-beta-access/005; the awaiting-review and declined surfaces themselves are closed-beta-access/008.

## Requirements

- The visitor's identity is verified on the server and their effective access resolved from the product backend before a gated route renders. A client-only check does not satisfy this requirement.
- Routing outcomes are explicit and total: a signed-out visitor gets the landing page; a signed-in visitor who is awaiting review or declined gets the holding surface; an admitted visitor gets the product exactly as it exists today; and an undetermined result gets a fail-closed, non-blank state that explains the problem and offers a retry — never the product, and never a redirect loop.
- The public path set is explicit and minimal: the landing page at the root, the holding surface, health and status probes, static assets, and whatever callback or lifecycle paths the authentication provider itself requires. Every other path is gated, including the dashboard, the repacks surface, learn articles, and the frontend's own data-serving routes.
- The frontend's own routes that serve catalog or search data require an admitted caller and refuse others with a stable, non-leaking outcome. The health probe stays open. Telemetry intake must not become an unauthenticated channel for product data.
- Gated surfaces are excluded from search indexing while the beta is on; the landing page remains indexable, and any robots or sitemap surface reflects that split.
- No flash of gated content and no redirect loop, including for the lazily-booted authentication provider: a signed-out visitor on the landing page must still not pull the provider before intent, and a returning session must not bounce between surfaces while the provider initializes.
- Decision changes take effect promptly: a revoked or declined user loses the product on their next navigation. Any per-request reuse of a resolved decision is short-lived and documented, and never outlives a decision change in a way the user can observe.
- The gate adds at most one bounded backend resolution to a request path; it must not multiply round trips per rendered page or make an unavailable backend look like an admitted visitor.
- Signing out is reachable from every gated state, so nobody can be stuck signed in as the wrong identity.
- When the beta switch is off, the product is fully public again exactly as today: the landing page no longer intercepts the root, gated routes render for anyone, and the indexing exclusions lift.
- Behavior specifications that currently assert full public browsing — notably the authentication feature's scenario stating that an anonymous visitor keeps full public access — are updated to describe beta-gated access. No test is deleted to make the gate pass; tests are rewritten to the new truth.

## User-Facing Behavior

A stranger opening any PackScout URL during the beta gets the landing page. Signing in either drops them straight into the product (allowlisted or already approved) or onto the holding surface. An admitted user browses exactly as before. Someone whose access is revoked finds themselves on the holding surface at their next click, without having to sign out. If the backend cannot answer, the visitor sees a clear "we can't confirm your access right now" state with a retry, not the product and not a blank page.

## Interface Contract

- Server-side gating resolves the visitor's identity and consumes the effective-access resolution and gate-status read from closed-beta-access/001; it does not re-derive admission rules locally.
- It renders the landing surface from closed-beta-access/006 for unadmitted visitors at the root, and hands awaiting-review, declined, and suspended visitors to the holding surface owned by closed-beta-access/008, passing the reason so that surface can say the right thing.
- The frontend's data-serving routes gate on the same resolution and refuse with a stable, non-leaking outcome.
- The gate reads the beta switch through the backend's gate-status read rather than any client-visible configuration.
- Read-path credential handling for catalog reads belongs to closed-beta-access/005; this task does not duplicate it.

## Acceptance Criteria

- [ ] A gated route requested by a signed-out visitor returns the landing experience and no gated markup or catalog data.
- [ ] Awaiting-review, declined, and suspended visitors reach the holding surface with the correct reason; admitted visitors reach the product unchanged.
- [ ] An undetermined access result produces a fail-closed retry state — never the product, never a blank page, never a loop.
- [ ] The frontend's data-serving routes refuse unadmitted callers with a stable non-leaking outcome; the health probe stays open.
- [ ] Gated surfaces are excluded from indexing and the landing page is not, while the beta is on.
- [ ] A revoked user loses the product on their next navigation without signing out; signing out is reachable from every gated state.
- [ ] With the switch off, every route behaves exactly as it does today, including the root rendering the dashboard for anonymous visitors.
- [ ] The authentication feature's public-access behavior scenarios are updated to describe beta-gated access rather than contradicting it.

## Verification

Frontend route and gate tests prove every routing outcome (signed-out, awaiting review, declined, suspended, admitted, undetermined) for a representative gated route and for each member of the public path set; data-serving route tests prove refusal for unadmitted callers and an open health probe; a test proves no gated route emits catalog data before the access decision resolves; and both switch positions are covered. The frontend lint, typecheck, test, and build commands exit 0.
