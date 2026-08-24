# Feature: Closed-beta access

Status: verified build handoff — live-provider passes pending
Owner: product build

The closed beta as one connected system: who gets in, who is held, what a
stranger can reach, and how the gate lifts. Each scenario names the automated
checks that prove it, or states its manual gap outright; no scenario implies
coverage it does not have. The two standing gaps are consolidated at the end.
The authentication feature's public-access scenarios were rewritten for the
beta by closed-beta-access/007 and live in
[privy-auth.feature.md](../../privy-auth/scenarios/privy-auth.feature.md), so
the two specifications agree. Operating procedures and the configuration
reference live in
[docs/closed-beta-operations.md](../../../docs/closed-beta-operations.md).

## Scenario: A signed-out visitor reaches only the landing page

Given the closed beta switch is on
And a visitor presents no identity the backend recognizes
When they request the root, Repacks, Learn, a learn article, or catalog search
Then the server resolves access before anything renders: the root serves the landing page and every other gated route redirects there
And no gated markup or catalog data leaves in any response to them, including the streamed render payload
And the landing surface itself performs no catalog or authenticated read, captures no email, and links to no gated route

Coverage: Automated — `apps/frontend/lib/access-gate.server.test.ts` (total routing outcomes; "an unadmitted request never reaches the catalog search read"), `apps/frontend/app/route-access-gate.source.test.ts` ("every gated page resolves access before any catalog read", "the root branches totally: landing, product, or the holding redirect"), `apps/frontend/components/landing/landing-surface.source.test.ts` ("rendering the landing surface performs no catalog or authenticated read", "nothing on the surface points a signed-out visitor at a gated route"), and `apps/frontend/lib/landing-content.test.ts`. A live signed-out browser pass against a configured deployment remains pending (standing since closed-beta-access/007).

## Scenario: What an unadmitted party can still observe is exactly enumerated

Given the closed beta switch is on
When anyone probes the deployment without an admitted identity or the server rendering credential
Then the observable surface is exactly: the landing page at the root, the anonymous beta on/off boolean, the frontend health probe, the crawler policy, fixed-vocabulary telemetry-intake acknowledgements, and — for a signed-in but unadmitted person — their own access state and own verified sign-in identifiers on the holding surface
And every catalog refusal is byte-identical to the no-active-release answer, so a refusal reveals nothing about what data exists
And the backend's public query surface is source-enumerated, so a new public read fails the build until it is gated or consciously classified open

Coverage: Automated — `convex/publicCatalogReadAccess.test.ts` ("every public query is a gated catalog read or documented open, with no overlap", "the unauthenticated gate-status read answers while the beta is on and the catalog is closed", "the authenticated self-reads stay reachable for a held identity", "refusals are byte-identical to the release-unavailable result and carry no catalog fields"), `convex/productUserAccess.test.ts` ("reports gate status to unauthenticated callers and nothing else"), `apps/frontend/app/route-access-gate.source.test.ts` ("catalog search is guarded before its handler and the health probe stays open", "telemetry intake stays a write-only surface with fixed responses", "the robots surface serves the fail-closed policy dynamically"), `apps/frontend/app/api/health/route.behavior.test.ts`, and `apps/frontend/app/robots.behavior.test.ts`.

## Scenario: An allowlisted identity signs in and is in the product immediately

Given an operator added a person's email or wallet address to the allowlist before they ever signed in
When that person signs in and the identity provider verifies a matching identifier
Then their record is established approved with provenance naming the allowlist entry, with no waiting step
And their next server-rendered navigation serves the product
And an identifier the provider verifies only on a later contact admits the waiting account the moment it appears

Coverage: Automated — `convex/betaAllowlist.test.ts` ("admits a first sign-in whose verified email matches an entry, with provenance naming it", "matches a verified wallet address case-insensitively in both directions", "admits an already-waiting identity the moment a later contact verifies a listed identifier", "never admits an identity without a verified matching identifier") and `apps/frontend/lib/access-gate.server.test.ts` ("a verified admitted identity resolves to admitted"). Manual gap — the sign-in itself: the identity-cookie round trip against a live Privy app cannot run in this workspace, the feature's standing live-verification gap (closed-beta-access/007).

## Scenario: A non-allowlisted identity signs in and lands in review

Given a person's verified identifiers match no allowlist entry and no operator has decided about them
When they sign in
Then their first contact records one awaiting-review decision, and every gated route routes them to the holding surface, which re-resolves server-side and shows the waiting notice
And the waiting notice reads as a normal state with no invented promises, offering sign-out and switching identity
And their authenticated capabilities refuse with the awaiting-review code instead of admitting, and the signed-in shell survives the refusal

Coverage: Automated — `convex/productUserAccess.test.ts` ("first authenticated contact records one awaiting-review decision with default provenance", "switch on denies by default for the same identity the off position admits"), `convex/productUserCapabilityGate.test.ts` ("refuses each unadmitted state with its own stable code, distinct from auth failures"), `apps/frontend/lib/access-gate.server.test.ts` ("each held reason survives the resolution intact"), `apps/frontend/app/route-access-gate.source.test.ts` ("the holding surface re-resolves server-side and renders from the gate's reason"), `apps/frontend/lib/access-holding-content.test.ts` ("waiting reads as a normal state with no invented promises"), and `apps/frontend/components/auth/session-refusal-tolerance.source.test.ts`. Manual gap — the same live Privy sign-in round trip as the allowlisted journey.

## Scenario: An administrator seeds and maintains the allowlist without touching the database

Given a deployment whose administrator operator account exists
When the administrator opens Allowlist in the admin and adds the first entries by email or wallet address
Then entries are created through the authenticated operator integration — never by editing the database — with duplicates refused as human messages and every add, edit, and remove audited
And adding or updating an entry immediately admits matching awaiting-review accounts and reports exactly how many, including an explicit zero
And removing an entry stops future automatic admission while evicting nobody already approved

Coverage: Automated — `apps/admin/src/pages/BetaAllowlistPage.test.tsx` ("adding an entry reports how many waiting accounts it admitted", "an add that admits nobody says so instead of implying it did", "removal states both consequences before anything happens, then converges"), `apps/admin/server/routes/beta-allowlist.behavior.test.ts` (authorization matrix, session-stamped operator, audit emission), and `convex/betaAllowlist.test.ts` ("adding an entry immediately admits matching awaiting-review accounts and reports the count", "an entry can predate its person; removal stops future admission and evicts nobody", "refuses every caller without the configured integration secret").

## Scenario: An operator approves a waiting visitor, who enters without signing in again

Given a visitor is signed in and holding on the waiting surface
When an operator approves them from the review queue or the user detail view
Then the decision converges on approved with operator provenance, the acted-on row updates in place, and the waiting count moves
And the open holding surface's live self-read observes the approval and moves the visitor into the product with no new sign-in
And a visitor who had closed the tab is admitted by the server gate on their next navigation, because the identity decision is never cached

Coverage: Automated — `convex/productUserAccessReview.test.ts` ("approve admits an awaiting identity with operator provenance and reports the decision pair", "two operators deciding at once converge on one authoritative decision"), `apps/admin/src/pages/ProductUsersPage.test.tsx` ("approving from the queue confirms the consequence, then updates the row in place"), `apps/frontend/components/access/access-holding-presentation.test.ts` ("an approval arriving while the surface is open moves the visitor into the product without a re-login"), `convex/productUserCapabilityGate.test.ts` ("a session established before a decline, revocation, or re-approval sees the change on its very next call, with data intact"), and `apps/frontend/lib/access-gate.server.test.ts` ("the identity decision is never cached: a revocation bites on the very next resolution"). Manual gap — the live flip end to end, a real waiting browser moving into the product, needs a configured Privy app plus the Convex sync protocol, neither available in this workspace (standing since closed-beta-access/008).

## Scenario: A declined person sees the declined surface, and the decline stands

Given an operator declines an access request
When the person next navigates, or is watching the holding surface as the decision lands
Then they see the declined notice — brief, respectful, no reasons, no review promise, no sign-in loop — and their capabilities refuse with the declined code
And a later allowlist entry matching their identifier never overturns the decline; only an operator returning them to review reopens admission

Coverage: Automated — `apps/frontend/lib/access-holding-content.test.ts` ("declined is brief and respectful: no reasons, no review, no sign-in loop"), `apps/frontend/components/access/access-holding-presentation.test.ts` ("a decline arriving while the surface is open swaps the notice and its document title in place"), `convex/productUserCapabilityGate.test.ts` ("refuses each unadmitted state with its own stable code, distinct from auth failures"), `convex/productUserAccessReview.test.ts` ("an operator decline is not overturned by a later allowlist addition for the same identifier"), and `convex/betaAllowlist.test.ts` ("never overturns a declined decision, no matter what the list says").

## Scenario: A revoked account loses the product on its next navigation

Given an admitted person is using the product
When an operator revokes their access, returning them to awaiting review
Then their very next server-rendered navigation lands on the holding surface — the identity decision is re-resolved from the record on every request
And their very next authenticated capability call and direct catalog read refuse
And nothing they saved is deleted: re-approval finds every row intact, and a still-standing allowlist entry admits them again on their next contact

Coverage: Automated — `apps/frontend/lib/access-gate.server.test.ts` ("the identity decision is never cached: a revocation bites on the very next resolution"), `convex/productUserCapabilityGate.test.ts` ("a session established before a decline, revocation, or re-approval sees the change on its very next call, with data intact"), `convex/publicCatalogReadAccess.test.ts` (the per-read refusal matrix drives awaiting-review callers), `convex/productUserAccessReview.test.ts` ("revocation returns the identity to the normal admission machinery, where a standing invitation applies again"), and `apps/admin/src/pages/ProductUsersPage.test.tsx` ("revoking an admitted account spells out the lockout and the allowlist caveat").

## Scenario: A suspended account sees the suspension notice, never review wording

Given an approved account is suspended by an operator
When the person next navigates or calls a capability
Then the composed decision reads suspended and the holding surface shows the suspension notice, distinct from the review notice in every visitor-facing field
And capability refusals use the shared suspended code, and direct catalog reads refuse them like strangers
And reinstatement composes back to admitted with no admission decision changed

Coverage: Automated — `apps/frontend/lib/access-holding-content.test.ts` ("suspended is its own notice, never presented as review", "every reason renders distinct copy in every visitor-facing field"), `apps/frontend/components/access/access-holding-presentation.test.ts` ("a suspension arriving lands on the suspension notice, never on review wording"), `convex/productUserCapabilityGate.test.ts` ("refuses each unadmitted state with its own stable code, distinct from auth failures"), and `convex/publicCatalogReadAccess.test.ts` ("declined and suspended identities are refused like strangers", "a suspended admitted account regains catalog reads when reinstated").

## Scenario: A direct catalog read without an admitted identity or the server credential is refused

Given the closed beta switch is on
And the backend's public address is known, as it is to every browser
When any caller invokes any enumerated public catalog read directly — anonymous, wrong credential, malformed credential, or a held identity
Then the read refuses with a result byte-identical to the no-active-release answer, carrying no catalog fields and no admission detail
And an absent, too-short, or too-long configured credential authorizes nobody — the gate fails closed on both ends
And the frontend presents the credential only from server-only code, so it reaches no browser bundle, markup, or log

Coverage: Automated — `convex/publicCatalogReadAccess.test.ts` ("while the beta is on, no enumerated catalog read is reachable without one of the two admitted callers", "an unconfigured deployment refuses every presented credential", "a configured secret below the minimum length authorizes nobody", "an over-long or non-string presented credential is refused in-band, never thrown") and `apps/frontend/lib/public-repacks.server.test.ts` (frontend credential bounds, per-read attachment, bounded degradation when unconfigured or unreachable).

## Scenario: Turning the switch off makes the product fully public again

Given the beta has been running, with allowlist entries, waiting requests, declines, and suspensions on record
When `PACKSCOUT_CLOSED_BETA` is removed from the Convex deployment
Then the root serves the dashboard to anonymous visitors, gated routes render for anyone, catalog search passes through, and catalog reads are public with no credential — a still-configured credential changes nothing
And the indexing exclusions lift, reaching each frontend server process within one gate-status cache window
And no data or account state changes: decisions, standings, and saved items persist, suspension keeps exactly its pre-beta meaning, and turning the switch back on re-applies the recorded decisions

Coverage: Automated — `apps/frontend/lib/access-gate.server.test.ts` ("with the switch off the root serves the product to anonymous visitors and all indexing exclusions lift", "with the switch off every visitor resolves to public and no identity is read", "a switch flip is visible within one TTL", "admitted and fully public callers pass through to the wrapped handler"), `convex/publicCatalogReadAccess.test.ts` ("every catalog read serves anonymous callers with no credential exactly as before", "the credential does not bypass the switch-off public contract"), `convex/productUserCapabilityGate.test.ts` ("unadmitted and even declined identities keep every capability while the switch is off", "suspension enforcement is exactly today's: writes refuse, reads never do", "a session admitted while the beta was off gains nothing once it turns on"), and `convex/betaAllowlist.test.ts` ("maintains allowlist decisions even while the beta switch is off").

## Standing manual gaps

Two live-provider passes remain open across the scenarios above, stated here
once so neither is implied away:

1. **The live Privy sign-in round trip** (closed-beta-access/007): a real
   hosted sign-in producing the identity cookie the server gate verifies. Every
   layer on both sides of that hop is behavior-tested; the hop itself needs a
   configured Privy app with PackScout's exact origins.
2. **The live approval flip** (closed-beta-access/008): a real waiting browser
   observing its approval through the Convex sync protocol and entering the
   product without re-login. The decision, the subscription contract, and the
   navigation are each automated; the connected pass needs a configured Privy
   app plus a reachable Convex deployment.

Both belong to the launch checklist in
[docs/closed-beta-operations.md](../../../docs/closed-beta-operations.md);
neither blocks the automated verification of any layer above.
