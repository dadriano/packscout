# Task: Add the Public Landing Page

**ID:** closed-beta-access/006
**Depends on:** none
**Blocks:** closed-beta-access/007
**Estimated scope:** medium
**Status:** done

## Objective

PackScout gets a public landing page that explains what the product is and invites the visitor to sign in — the one product surface a signed-out visitor can reach during the closed beta.

## Context

Today the site root is the dashboard: a signed-out visitor lands directly in the catalog. During the closed beta the root has to greet strangers instead, tell them what PackScout is, and give them exactly one thing to do — sign in. People who are on the allowlist go straight through; everyone else lands in review (closed-beta-access/008).

This task builds the surface. The decision of *who* sees it — and the server-side enforcement behind that decision — belongs to closed-beta-access/007, which wires the root to render this page for visitors who are not admitted and the existing dashboard for those who are. Keeping them separate means this page can be built, reviewed, and looked at on its own, and it means the root's existing links, filter URLs, and provider-banner destinations never move.

Two existing invariants must survive. The landing page must render with no catalog data at all, because the read model is being closed (closed-beta-access/005) and this page has to work for someone with no access whatsoever. And the authentication provider must still load only when the visitor asks for it: the product deliberately does not pull the wallet/social provider's dependency graph until a returning session or an explicit sign-in intent, and a landing page that eagerly boots it would throw that away on the most-visited page on the site.

## Requirements

- The landing page states plainly what PackScout is and what it does for a collector, in the product's own voice, without overclaiming.
- It says honestly that access is limited during the closed beta and what happens when you sign in: allowlisted people go straight in, everyone else is placed in review.
- Its primary action is signing in through the same hosted wallet/social provider the product already uses. No second identity system, no separate beta registration form, no email capture — the sign-in record is the access request.
- The page renders with no catalog read and no authenticated read of any kind, so it works while signed out and while the catalog read model is closed.
- The authentication provider is not loaded or initialized before the visitor chooses to sign in (or is a returning session), preserving the product's existing intent-based provider boot, and its arrival causes no layout shift.
- A visitor who is already signed in but not admitted is not stranded here: the sign-in action reflects that state rather than looping them through another sign-in.
- The page is a self-contained surface, addressable and renderable on its own so it can be tested and reviewed independently, and consumable by the root route when closed-beta-access/007 wires the branch.
- It uses the product's existing visual system and shell primitives rather than one-off styling, and the surrounding shell shows nothing a signed-out visitor cannot use — no authenticated navigation, saved-item affordances, or account controls in an active state.
- It meets the project's UI and accessibility standard: one page-level heading, keyboard-reachable actions with visible focus, correct document title and description, sensible landmark structure, working light and dark themes, and no page-level horizontal overflow at desktop or narrow widths.
- It is the marketing surface, so it is indexable and carries meaningful title, description, and social metadata. (Making the gated surfaces non-indexable belongs to closed-beta-access/007.)

## User-Facing Behavior

A stranger opens PackScout and sees a page that explains the product, states that it is in closed beta, and offers a single sign-in action. Choosing it opens the existing sign-in flow. Someone on the allowlist signs in and lands in the product; anyone else signs in and lands on the awaiting-review surface. Nothing on the page reveals catalog data, and nothing asks for personal details beyond the sign-in itself.

## Interface Contract

- A landing surface that renders with no catalog or authenticated data, exported for the root route to render for visitors who are not admitted (wired by closed-beta-access/007) and addressable on its own for direct verification.
- It consumes only the existing frontend authentication context for its sign-in action and the signed-in-but-unadmitted case; it does not resolve or enforce the access decision itself.
- It does not alter the root route's existing behavior for admitted visitors, and moves no existing route or link target.

## Acceptance Criteria

- [x] The landing surface renders for a signed-out visitor with product explanation, an honest closed-beta statement, and a working sign-in action.
- [x] Rendering it performs no catalog read and no authenticated read, and it renders correctly when the catalog read model is closed.
- [x] The authentication provider is not initialized before sign-in intent, and no layout shift occurs when it loads.
- [x] A signed-in-but-unadmitted visitor sees an action appropriate to that state rather than a second sign-in loop.
- [x] The page satisfies the UI and accessibility standard: single page heading, keyboard-reachable actions, correct title and description, working light and dark themes, and no horizontal overflow at desktop and narrow widths.
- [x] Existing dashboard routes, filter URLs, and provider-banner destinations are unchanged.

## Verification

Frontend tests render the landing surface signed-out and signed-in-unadmitted, asserting its content, single page heading, sign-in action, absence of any catalog or authenticated read, and that the authentication provider is not initialized before intent. Layout is checked at desktop and narrow widths with no page-level horizontal overflow in both themes. The frontend lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` (the root stays dual-purpose and is wired by 007; robots de-indexing of gated surfaces is 007's; the awaiting/declined experience is 008's).
- Alignment: the landing surface lives in `apps/frontend/components/landing/` — `LandingPage.tsx` is a server-renderable presentation with no data dependencies, `LandingAccessCta.client.tsx` is the only interactive piece and consumes the existing `usePackScoutAuth()` context, and `landing-presentation.ts` maps every auth status to the one access action (sign-in command for signed-out, busy while booting, "Continue to PackScout" for signed-in and error, plain unavailability when auth is unconfigured — never a second sign-in). All copy and the route metadata live in `apps/frontend/lib/landing-content.ts` (the `learn-content` convention), so honesty claims are test-asserted: what PackScout is, closed beta stated plainly, allowlisted-go-straight-in / everyone-else-in-review, no email capture, EV always qualified as a long-run estimate. The intent-based provider boot is untouched — the surface imports nothing from Privy or Convex and sends the same `auth.login()` boot intent every other control sends; every CTA state renders inside one 128px-reserved slot so the provider's arrival shifts nothing. `app/welcome/page.tsx` keeps the surface addressable on its own and exports `LANDING_METADATA` (absolute title, search-snippet description, OpenGraph and Twitter text, no robots directive so it stays indexable). No existing route, filter URL, or provider-banner destination moved.
- Divergences: (1) The standalone address is a new additive route `app/welcome/page.tsx` rather than a test-only harness, because the repository's test lane has no DOM renderer and the UI standard requires a browser smoke pass; 007 may keep or retire it when wiring `/`. It reports the shell's release status as a static `unavailable` literal (the dashboard's own no-data pattern) so the shell freshness widget does not sit in "checking" forever — the page itself still performs no read. (2) Social metadata is text-only (OG/Twitter titles and descriptions, no image): the repository has no social-card asset, and the 128px favicon is below crawler minimums; adding an image belongs with a real asset. (3) The signed-in and error states both resolve to a root navigation with state-appropriate copy; distinguishing admitted from in-review there is deliberately left to 007/008. (4) On the standalone address the surrounding chrome is today's public `AppShell` (its links and search are public surfaces on this branch); the landing surface itself renders no navigation, saved-item affordances, or account controls, and the beta-time shell around `/` belongs to 007.
- Verification: `npm run lint:frontend && npm run typecheck:frontend && npm run test:frontend && npm run build:frontend && npm run scan:framework-standards:ratchet` → exit 0 (217 tests passed, 0 failed, including `lib/landing-content.test.ts` 5 tests, `components/landing/landing-presentation.test.ts` 7 tests, `components/landing/landing-surface.source.test.ts` 7 tests; build emits `/welcome` alongside unchanged existing routes; ratchet 0 findings, 0 new). Browser smoke on the worktree servers (dev and production build): `/welcome` at 1280×800 and 375×812 in light and dark — `scrollWidth === clientWidth` with zero elements crossing the viewport at both widths, exactly one `h1` (route-focus target), h1→h2→h3 hierarchy, CTA slot measured 128px under all five auth-state texts at both widths, keyboard Tab reaches the action with the visible 2px `--color-focus` ring at 3px offset, decimal step markers restored over the shared list reset. Environment caveat recorded: the sandboxed browser pane never fires `requestAnimationFrame`, so React's streamed suspense reveal had to be invoked manually (`$RV`) to reach the settled DOM; `/learn` exhibits the identical pane behavior and `curl` shows both boundary completions in the served HTML from dev and production servers, so this is a pane quirk, not a page defect.
