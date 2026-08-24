# Feature: Optional Privy authentication and saved discovery

Status: active build handoff — live Privy verification pending
Owner: product build

## Scenario: An anonymous visitor is beta-gated to the landing page

Given the closed beta switch is on
And the visitor is signed out or presents no identity the backend recognizes
When they request Dashboard, Repacks, Learn, catalog search, or any other product route
Then the server resolves their access before anything renders and serves the landing page at the root, redirecting every other gated route there
And no gated markup or catalog data leaves in any response to them, including the streamed render payload
And the frontend catalog search route refuses them with a stable non-leaking outcome while the health probe stays open

Coverage: Automated — `apps/frontend/lib/access-gate.server.test.ts` (total routing outcomes, fail-closed resolution, guarded data route: "an unadmitted request never reaches the catalog search read"), `apps/frontend/app/route-access-gate.source.test.ts` ("every gated page resolves access before any catalog read"), `apps/frontend/app/api/collectibles/search/route.behavior.test.ts`, and `apps/frontend/app/api/health/route.behavior.test.ts`; live signed-out browser coverage remains pending.

## Scenario: The full public experience returns exactly when the beta switch is off

Given the closed beta switch is off
When an anonymous buyer opens Dashboard, Repacks, Learn, or catalog search
Then the public experience is available without an account exactly as it was before the beta, with the root rendering the dashboard
And no authentication token, cookie, or user profile is required for a public read
And the beta's indexing exclusions lift

Coverage: Automated — `apps/frontend/lib/access-gate.server.test.ts` ("with the switch off every visitor resolves to public and no identity is read", "with the switch off the root serves the product to anonymous visitors and all indexing exclusions lift", "a switch flip is visible within one TTL") and `npm run build:frontend`.

## Scenario: A signed-in session gives the server a verifiable identity signal

Given a buyer establishes a session through the hosted provider
When the session is created, refreshed, or ended
Then the provider-issued identity token is mirrored into a same-site, path-wide cookie whose lifetime never exceeds the token's own expiry
And the server treats that cookie as an unverified claim, re-verifying it against the product backend on every gated request rather than trusting it
And signing out clears the cookie together with the returning-session hint

Coverage: Automated — `apps/frontend/lib/identity-cookie.test.ts`, the identity-cookie boundary test in `apps/frontend/components/auth/auth-boot-boundary.source.test.ts`, and server verification and refusal mapping in `apps/frontend/lib/access-gate.server.test.ts`; live token round-trip verification remains pending with a real Privy app.

## Scenario: Authentication initializes only after intent

Given a valid Privy app is configured and the buyer has no returning-session hint
When the buyer opens any public PackScout route without choosing Sign in or Save
Then PackScout does not load or initialize the Privy or wallet dependency graph
And it does not create a Privy identifier or emit Privy initialization telemetry
When the buyer chooses Sign in or Save
Then PackScout loads the provider and opens the approved login flow once it is ready

Coverage: Automated — auth boot reducer/source tests and configured production
bundle inspection prove the heavy provider is absent before intent. A live Privy
app is still required to verify the provider's post-intent network behavior.

## Scenario: A buyer signs in with email or Google

Given a valid Privy app whose exact PackScout origin is allowed
When the buyer completes email OTP or Google OAuth
Then PackScout exposes authenticated save actions without creating a wallet
And cancelled, failed, or expired authentication leaves public browsing usable

Coverage: Manual gap — both hosted provider flows require an actual Privy app, exact allowed origins, and real email/Google interaction.

## Scenario: An authenticated buyer saves and unsaves a repack

Given the buyer is authenticated and a stable public repack is visible
When the buyer saves and then unsaves that repack
Then each action reaches one deterministic saved or unsaved state
And repeated actions do not create duplicate ownership records

Coverage: Automated — Convex saved-item mutation tests and frontend save-state tests; live browser verification remains pending.

## Scenario: An authenticated buyer saves an exact desired collectible

Given the buyer selected a stable exact collectible identity from search
When the buyer saves that desired collectible
Then the saved record references that exact identity rather than raw search text
And duplicate saves remain idempotent

Coverage: Automated — Convex saved-item mutation tests and existing exact-collectible identity/search tests; live browser verification remains pending.

## Scenario: Retired saves cannot permanently block current saves

Given a buyer has reached the bounded save capacity for one item kind
And at least one of those saved entities is unavailable from the active release
When the buyer saves a new active entity of that same kind
Then PackScout removes only that buyer's oldest unavailable save to make room
And the success message discloses the capacity recovery without exposing the retired public ID
And saves owned by another buyer or belonging to the other item kind are unchanged

Coverage: Automated — Convex capacity, deterministic-pruning, ownership, and
kind-isolation tests plus frontend bounded-message tests.

## Scenario: Authentication failures fail closed

Given a request has no identity or an invalid, expired, wrong-issuer, or wrong-audience token
When it attempts a saved-item read or mutation
Then the operation returns a stable unauthorized outcome
And no saved data or provider diagnostic is exposed

Coverage: Partial automation — Convex saved-item tests prove the unauthenticated
function boundary and the static issuer, audience, algorithm, and JWKS
configuration. `convex-test.withIdentity` bypasses JWT verification, so invalid,
expired, wrong-issuer, and wrong-audience tokens still require a real-token
deployment test. Live session-expiry verification also remains pending.

## Scenario: Saved data is isolated between buyers

Given two authenticated buyers have different Privy subjects
When either buyer reads or changes saved repacks or collectibles
Then only records owned by that authenticated subject are returned or changed
And a client-supplied owner cannot cross the identity boundary

Coverage: Automated — Convex cross-user isolation tests; adversarial live-provider verification remains pending.

## Scenario: Authentication keeps a strict CSP

Given a bounded `NEXT_PUBLIC_PRIVY_APP_ID` is configured
When PackScout builds its document policy in development or production
Then it adds only the exact Privy authentication and Turnstile sources
And nonce plus `strict-dynamic` script protection remains in force without wallet, RPC, or generic wildcard sources

Coverage: Automated — `apps/frontend/lib/security-policy.server.test.ts` and `apps/frontend/proxy.test.ts`; real-provider CSP console verification remains pending.

## Scenario: Anonymous telemetry carries no ambient authentication

Given an authenticated browser emits an approved anonymous product event
When PackScout queues telemetry or a public-read failure
Then it uses a keepalive request with credentials omitted and no referrer
And the event contains no Privy subject, email, token, wallet, cookie, or raw search value

Coverage: Automated — `apps/frontend/lib/telemetry.client.test.ts`, `apps/frontend/lib/telemetry-contract.test.ts`, and API route behavior tests.

## Scenario: Authentication and save controls remain accessible on narrow screens

Given a signed-out or signed-in buyer uses keyboard, touch, zoom, reduced motion, or a narrow viewport
When the buyer opens authentication and uses either save action
Then focus, accessible names, pending and error announcements, dismissal, and focus return remain usable
And controls do not obscure public catalog content or cause page-level overflow

Coverage: Manual gap — browser smoke at desktop, 390×844, keyboard-only, and 200% zoom requires a configured live Privy app.
