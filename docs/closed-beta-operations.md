# Closed-Beta Operations

Status: closed-beta operator contract

While the closed beta is on, PackScout admits people through an allowlist or
an operator's decision and turns everyone else away at three doors that read
one shared decision: the site's server rendering (no gated page or embedded
data for unadmitted visitors), the authenticated product capabilities (no
saved-item reads or writes), and the catalog read model itself (no direct
data pulls against the backend's public address). One deployment switch turns
all three on and off together. This document is the operator's contract for
running the beta day to day and for ending it.

The end-to-end behavior record, with every journey's automated checks and the
two standing live-verification gaps, is
[.tasks/closed-beta-access/scenarios/closed-beta-access.feature.md](../.tasks/closed-beta-access/scenarios/closed-beta-access.feature.md).

## How to tell whether the beta is on

- Authoritative: read the switch on the confirmed Convex deployment —
  `npx convex env get PACKSCOUT_CLOSED_BETA` (add `--deployment <name>` or
  `--prod` to name the target). The beta is on exactly when the value is `1`.
- Observable: open the site root in a private (signed-out) window. The landing
  page means the beta is on; the dashboard means it is off. A flip reaches
  each frontend server process within 30 seconds (the gate-status cache
  window), so give a just-flipped switch that long before judging.

## Configuration reference

Every value the gate depends on, what it does, where it lives, whether a
browser may ever see it, and what the product does when it is missing or
wrong. None of the secrets below belongs in a `NEXT_PUBLIC_` or otherwise
browser-visible variable, a log line, or a tracked file.

### `PACKSCOUT_CLOSED_BETA` — the beta switch

- Purpose: closes PackScout to unadmitted callers at all three doors.
- Lives: Convex deployment environment only. The deployment configuration
  (`convex/convex.config.ts`) declares `1` as the only accepted value, and the
  code treats the beta as on exactly when the value is the string `1`
  (proved by `convex/productUserAccess.test.ts`, "only the exact configured
  value closes the beta"). Turn the beta off by removing the variable
  (`npx convex env remove PACKSCOUT_CLOSED_BETA`), not by writing a
  different value.
- Browser visibility: never set client-side. Browsers learn only the on/off
  boolean through the anonymous gate-status read, which answers with that
  boolean and nothing else.
- Missing: the beta is off — the product is fully public, exactly its
  pre-beta shape. There is no misconfigured-on state: any value other than
  `1` is not the beta being on.

### `PACKSCOUT_CATALOG_READ_TOKEN` — the server rendering credential

- Purpose: while the beta is on, catalog reads accept exactly two callers —
  an admitted product identity, and PackScout's own server rendering
  presenting this credential. The credential authorizes the server, never a
  visitor.
- Lives: both ends under the same name — the Convex deployment environment
  and the frontend server environment. Bounds on both ends: 32 to 512
  characters after trimming.
- Browser visibility: never. It is not a `NEXT_PUBLIC_` variable; the
  frontend attaches it from server-only code as a query argument on its
  existing catalog reads, so it reaches no bundle, no page markup, no log,
  and no error payload (post-build scan recorded in closed-beta-access/005).
- Missing or out of bounds: both ends fail closed. The backend authorizes
  nobody by credential; the frontend sends nothing and the product surfaces
  render their existing bounded "data temporarily unavailable" states —
  never a crash, never data. A wrong value is refused byte-identically to
  "no release is active", revealing nothing.
- With the beta off: ignored entirely; a configured value changes nothing.
  Leave it configured so a later return to beta needs only the switch.

### `PACKSCOUT_ADMIN_DIRECTORY_URL` and `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` — the operator integration

- Purpose: the one authenticated server-to-server integration between the
  admin and the product backend. Everything the beta's operator surfaces do
  rides it: the product-user directory, the beta allowlist, the review queue
  and access decisions, and the welcome-message dispatch.
- Lives: the admin server environment holds both; the same token is also set
  on the Convex deployment (`npx convex env set
  PACKSCOUT_ADMIN_DIRECTORY_TOKEN <value>` against the confirmed
  deployment). The URL must be the deployment's HTTP Actions origin over
  HTTPS (loopback HTTP is accepted only in development). The token must be at
  least 32 characters; transport accepts 32 to 512.
- Browser visibility: never. The token authorizes reading personal data
  (email addresses and wallet-linked identities); the admin server never
  sends it — or any upstream error body — to the browser.
- Missing or wrong: safe on both ends. The admin boots and its Users and
  Allowlist pages show the bounded "not connected" state instead of failing;
  the Convex side refuses every integration request while its configured
  secret is absent or shorter than 32 characters.

### `NEXT_PUBLIC_CONVEX_URL` — the backend origin (prerequisite)

- Purpose: the public Convex origin the frontend reads from; the access gate
  resolves every decision through it.
- Lives: frontend environment. Deliberately browser-visible — it is a public
  origin, not a secret.
- Missing: the gate fails closed with zero backend calls — gated routes
  resolve to the retry surface, never the product, and the crawler
  exclusions stay in place (proved by `apps/frontend/lib/access-gate.server.test.ts`,
  "a deployment with no backend origin fails closed with zero calls").

### `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_ID` — sign-in (prerequisite)

- Purpose: the hosted authentication provider's public app identifier, set
  matching on the frontend and the Convex deployment so the backend can
  verify identity tokens. Sign-in is how anyone requests access, so the beta
  needs it configured even though the gate itself does not read it.
- Lives and bounds: see the "Optional Privy authentication" section of the
  [README](../README.md) for the exact setup, origin allowlisting, and the
  rule that these are public identifiers while every secret stays server-only.
- Missing: sign-in is unavailable. During the beta that means visitors can
  see the landing page but cannot request access; it never opens any catalog
  surface.

## The identity signal and its caching bounds

- The client mirrors the provider-issued identity token into the
  `packscout-identity` cookie: `SameSite=Lax`, `Path=/`, `Secure` on HTTPS.
  Its lifetime is the token's own expiry minus a 60-second margin, clamped to
  one hour; the client refreshes it every 10 minutes, on session changes, and
  when a backgrounded tab returns; signing out clears it.
- The cookie is transport, never trust: the server verifies it against the
  product backend on every gated request. The visitor-level decision is never
  cached — within one request the layout, page, and metadata share one
  resolution, and the next request resolves again — so a revocation or
  decline bites on the person's very next navigation.
- The only cross-request cache is the anonymous on/off gate status, kept per
  server process for 30 seconds (successes only). That window is the
  worst-case propagation for a switch flip; identity decisions have no such
  window.

## Runbook

The admin surfaces below require an operator with the administrator role;
data operators see states but no controls. Every add, edit, remove, and
decision is audited with the acting operator, and nothing in these flows
hard-deletes anything.

### See who is waiting

Open Users in the admin: the header shows the awaiting-review count (an
at-least "500+" when very large), and the Review queue view lists waiting
identities oldest request first. The queue is worked from the front, not
searched.

### Admit someone in advance

Allowlist (Workspace section) → Add entry → email address, wallet address, or
both, with an optional label. The success toast reports how many waiting
accounts the entry admitted the moment it was created — including an explicit
"nobody was admitted" when it matched no one yet.

What the person experiences: if they never signed in, their first sign-in
with a matching provider-verified identifier goes straight to the product
with no waiting step. If they were already waiting, they are admitted
immediately — a holding surface they have open moves them into the product
live, and otherwise their next navigation does it. A person whose matching
identifier the provider verifies only later is admitted at that later contact.

### Decide a waiting request

Users → Review queue → Approve or Decline on the row (or from the user's
detail view). Each action states that person's consequence and asks for
confirmation; the row then updates in place with the decision the backend
now holds, and the waiting count refreshes. Repeating a decision reports the
authoritative stored state rather than pretending a change; approving a
suspended account says plainly that they stay locked out.

What the person experiences: approved — the open holding surface moves them
into the product without a new sign-in, or their next navigation serves the
product. Declined — the declined notice: brief, respectful, no review
promise, no sign-in loop; their capabilities and catalog reads refuse. An
operator decline stands against any later allowlist entry until an operator
returns them to review.

### Revoke access

Users (ledger or detail view) → Revoke on an approved account ("Return to
review" on a declined one). Revocation returns the account to awaiting
review; it deletes nothing, and every flip is reversible. The confirmation
spells out the one caveat worth reading twice: a still-standing allowlist
entry re-admits them on their next contact, so remove their entry as well
when the revocation is meant to hold.

What the person experiences: their very next navigation lands on the waiting
notice, and their next capability call or direct catalog read refuses. Saved
items are untouched; re-approval finds everything intact.

### Suspension composes with admission

Suspending an account (the Users standing control, unchanged by the beta)
locks a person out while the beta is on even if they are approved, and they
see the suspension notice — deliberately distinct from the review notice.
Admission decisions are not changed by suspension; reinstatement composes
straight back to admitted.

### What reaches people by email

A first admitted sign-in arms a welcome message when the account has a
verified address (delivered through the same operator integration; a
wallet-only identity with no address is a normal state, not an error).
Decision notices by email belong to the messaging feature (`messaging/006`);
until that lands, the live holding surface and the next navigation are how
decisions reach people who closed the tab.

## Seeding a fresh deployment

The first allowlist entries never require hand-editing a database. The
bootstrap order:

1. An administrator operator account exists. Operator accounts are
   administrator-provisioned (admin-tools/001); deployment provisioning
   creates the approved administrator account, and the local demo lane
   (`npm run start:admin:embedded:local`) provisions its bootstrap
   administrator from `PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL`,
   `PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD`, and optional
   `PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME`.
2. The operator integration is configured on both ends
   (`PACKSCOUT_ADMIN_DIRECTORY_URL`, `PACKSCOUT_ADMIN_DIRECTORY_TOKEN`).
3. The administrator signs in to the admin and opens Allowlist.
4. They add the first invitees by email or wallet address — including any
   operator who wants product access: operators are not admitted by being
   operators and add their own identifier like anyone else.

## The beta boundary — what an unadmitted party can still observe

Stated so the exposure is known rather than assumed; each item is enforced by
the named automated check.

| Observable | Proof |
|---|---|
| The landing page at the root: what PackScout is, that the beta is closed, one sign-in action, no catalog data, no email capture | `apps/frontend/components/landing/landing-surface.source.test.ts`, `apps/frontend/lib/landing-content.test.ts` |
| The beta on/off boolean, anonymously | `convex/productUserAccess.test.ts` ("reports gate status to unauthenticated callers and nothing else") |
| The frontend health probe (`/api/health`), liveness only | `apps/frontend/app/api/health/route.behavior.test.ts`; `apps/frontend/app/route-access-gate.source.test.ts` ("catalog search is guarded before its handler and the health probe stays open") |
| The crawler policy (`/robots.txt`): allow the root, exclude `/access`, `/api/`, `/learn`, `/packs` while on or unknown | `apps/frontend/app/robots.behavior.test.ts`; `apps/frontend/lib/access-gate.server.test.ts` |
| Fixed-vocabulary acknowledgements from the telemetry intakes (write-only, same-origin-locked) | `apps/frontend/app/route-access-gate.source.test.ts` ("telemetry intake stays a write-only surface with fixed responses") |
| Signed-in but unadmitted: their own access state and own verified identifiers on the holding surface, nothing about anyone else | `convex/publicCatalogReadAccess.test.ts` ("the authenticated self-reads stay reachable for a held identity"); `apps/frontend/lib/access-holding-content.test.ts` |

Nothing else answers: the backend's public query surface is
source-enumerated, every unclassified query fails the build
(`convex/publicCatalogReadAccess.test.ts`, "every public query is a gated
catalog read or documented open, with no overlap"), and a refused catalog
read is byte-identical to "no release is active", so a probe learns nothing
about what data exists.

## Opening the product to the public

Ending the beta is one configuration change, not a project: remove
`PACKSCOUT_CLOSED_BETA` from the Convex deployment
(`npx convex env remove PACKSCOUT_CLOSED_BETA` against the confirmed
deployment). No deploy, no code change, no data migration. The expected
effects, each with the automated check that proves it:

| Effect | Proof |
|---|---|
| The landing page stops intercepting the root; anonymous visitors get the dashboard | `apps/frontend/lib/access-gate.server.test.ts` ("with the switch off the root serves the product to anonymous visitors and all indexing exclusions lift") |
| Every gated route renders for anyone, with no identity read; catalog search passes through | `apps/frontend/lib/access-gate.server.test.ts` ("with the switch off every visitor resolves to public and no identity is read", "admitted and fully public callers pass through to the wrapped handler") |
| Catalog reads are public again with no credential; a still-configured credential changes nothing | `convex/publicCatalogReadAccess.test.ts` ("every catalog read serves anonymous callers with no credential exactly as before", "the credential does not bypass the switch-off public contract") |
| Indexing exclusions lift: unrestricted robots policy, pre-beta route metadata | `apps/frontend/lib/access-gate.server.test.ts` (same switch-off test), `apps/frontend/app/robots.behavior.test.ts` |
| Authenticated capabilities return to their pre-beta posture; suspension keeps exactly its old meaning | `convex/productUserCapabilityGate.test.ts` ("unadmitted and even declined identities keep every capability while the switch is off", "suspension enforcement is exactly today's: writes refuse, reads never do") |
| No data or account state changes: decisions, standings, saved items, and allowlist entries persist, and allowlist matching keeps recording decisions for a possible return | `convex/betaAllowlist.test.ts` ("maintains allowlist decisions even while the beta switch is off"), `convex/productUserCapabilityGate.test.ts` ("a session admitted while the beta was off gains nothing once it turns on") |
| Propagation: each frontend server process sees the flip within 30 seconds | `apps/frontend/lib/access-gate.server.test.ts` ("a switch flip is visible within one TTL") |

Turning the beta back on is the reverse single change — set the variable to
`1` — and the recorded decisions apply again immediately.

## Verifying the beta

- `npm run verify:framework` — the workspace's canonical gate: boundaries,
  documentation checks, the standards ratchet, lint, types, every product
  and tooling test lane, and both builds.
- `node --test scripts/scenario-coverage-citations.test.mjs` — proves every
  "Coverage: Automated" citation in this feature's scenario set names a test
  file that exists, so the behavior record cannot silently rot.
- The two live-provider passes that remain manual before a public launch —
  the live sign-in round trip and the live approval flip — are listed with
  their reasons at the end of the
  [scenario set](../.tasks/closed-beta-access/scenarios/closed-beta-access.feature.md).
