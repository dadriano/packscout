# Task: Add the Public Landing Page

**ID:** closed-beta-access/006
**Depends on:** none
**Blocks:** closed-beta-access/007
**Estimated scope:** medium
**Status:** in_progress

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

- [ ] The landing surface renders for a signed-out visitor with product explanation, an honest closed-beta statement, and a working sign-in action.
- [ ] Rendering it performs no catalog read and no authenticated read, and it renders correctly when the catalog read model is closed.
- [ ] The authentication provider is not initialized before sign-in intent, and no layout shift occurs when it loads.
- [ ] A signed-in-but-unadmitted visitor sees an action appropriate to that state rather than a second sign-in loop.
- [ ] The page satisfies the UI and accessibility standard: single page heading, keyboard-reachable actions, correct title and description, working light and dark themes, and no horizontal overflow at desktop and narrow widths.
- [ ] Existing dashboard routes, filter URLs, and provider-banner destinations are unchanged.

## Verification

Frontend tests render the landing surface signed-out and signed-in-unadmitted, asserting its content, single page heading, sign-in action, absence of any catalog or authenticated read, and that the authentication provider is not initialized before intent. Layout is checked at desktop and narrow widths with no page-level horizontal overflow in both themes. The frontend lint, typecheck, test, and build commands exit 0.
