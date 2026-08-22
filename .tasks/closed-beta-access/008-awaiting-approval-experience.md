# Task: Awaiting-Approval and Declined Experience

**ID:** closed-beta-access/008
**Depends on:** closed-beta-access/007
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** todo

## Objective

A signed-in visitor who is not admitted gets one honest, plainly written surface that tells them exactly where they stand — and the moment an operator admits them, they are in, without signing out and back in.

## Context

Someone who signs in during the closed beta and is not on the allowlist has done nothing wrong: they are waiting. The approved reference web app gives these accounts a single holding page that says the account is pending approval and nothing more — no error styling, no dead end, no technical language.

PackScout needs the same, plus two things the reference does not have to handle. Its users can be in three different not-admitted states — awaiting review, declined, and suspended — and conflating them produces wrong and sometimes insulting messages. And its backend is reactive, so a person sitting on this page when an operator approves them can simply be let in, which removes the "I've been approved, why am I still stuck?" support thread entirely.

The person may also have signed in with the wrong identity — the wrong email, or a wallet when their invitation was for an address — so the page has to show which identity is under review and let them leave and try another.

## Requirements

- Awaiting review reads as a normal, expected state: their request is in review, what happens when it is decided, and no invented delivery promises or estimated times.
- Declined is a distinct, respectful message stating that access is not available. It exposes no operator notes, no reasoning, and no internal detail.
- Suspended is its own distinct notice, never presented as "awaiting review" — a suspended account is a different situation and gets different words.
- An undetermined access result — the backend could not answer — presents as a temporary problem with a retry, clearly separated from any decision about the person.
- The surface reacts to a decision change: an operator approving the visitor while they are on the page lets them into the product without a re-login, and a revocation or decline lands them here promptly. No stale cached decision keeps them out after they have been admitted.
- The identity they are signed in as is shown — only what the provider verified, nothing inferred — so they can tell whether they used the address they expected.
- Signing out and signing in as a different identity are both available from the surface.
- The surface performs no catalog read and grants no authenticated capability. It is reachable only by a signed-in visitor; a signed-out visitor gets the landing page.
- It tells the visitor what to do if they believe the state is wrong, using a contact path the product already has, without inventing a support system or a ticket form.
- It meets the project's UI and accessibility standard: one page-level heading, correct document title per state, keyboard-reachable controls with visible focus, working light and dark themes, and no page-level horizontal overflow at desktop or narrow widths.
- Copy is plain language throughout: no status codes, no reason identifiers, no backend vocabulary leaking into what the person reads.

## User-Facing Behavior

A visitor signs in, is not on the allowlist, and lands on a calm page telling them their request is in review, showing the email or wallet address they used, with a sign-out option and a note about what to do if something looks wrong. They leave it open; an administrator approves them; the page moves them into the product on its own. A declined visitor sees a different, brief message and is not left clicking a sign-in button that returns them to the same place. A suspended user sees a suspension notice rather than a review notice.

## Interface Contract

- The surface renders from the reason supplied by the gate (closed-beta-access/007) — awaiting review, declined, suspended, or undetermined — and maps each to distinct copy and controls.
- It reads the visitor's own effective access through the authenticated self-read from closed-beta-access/001 to react to decision changes; it makes no other authenticated call.
- It reuses the existing sign-out path from the frontend authentication context.
- It renders correctly while the catalog read model is closed.

## Acceptance Criteria

- [ ] Awaiting review, declined, suspended, and undetermined each render distinct, plain-language copy and the right controls.
- [ ] The visitor's verified sign-in identity is shown, and signing out and signing in as another identity both work from the surface.
- [ ] A decision change while the surface is open moves the visitor into the product (on approval) or onto the correct notice (on decline or revocation) without a re-login.
- [ ] The surface performs no catalog read and grants no authenticated capability, and renders while the catalog read model is closed.
- [ ] A signed-out visitor reaching the surface gets the landing page instead.
- [ ] The surface meets the UI and accessibility standard at desktop and narrow widths in both themes, with correct per-state document titles and no horizontal overflow.

## Verification

Frontend tests render each state with its distinct copy and controls, prove the surface moves the visitor into the product when the decision changes without a re-login, prove sign-out works from it, prove no catalog or capability call is made, and prove the signed-out redirect. Layout and theming are checked at desktop and narrow widths with no page-level horizontal overflow. The frontend lint, typecheck, test, and build commands exit 0.
