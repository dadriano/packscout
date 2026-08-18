# Feature: Optional Privy authentication and saved discovery

Status: active build handoff — live Privy verification pending
Owner: product build

## Scenario: An anonymous buyer keeps full public access

Given Privy is unconfigured or the buyer is signed out
When the buyer opens Dashboard, Repacks, Learn, or catalog search
Then the public experience remains available without an account
And no authentication token, cookie, or user profile is required for a public read

Coverage: Automated — `apps/frontend/lib/security-policy.server.test.ts`, existing public route tests, and `npm run build:frontend`; live signed-out browser coverage remains pending.

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
