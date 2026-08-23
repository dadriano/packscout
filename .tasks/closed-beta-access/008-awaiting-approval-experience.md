# Task: Awaiting-Approval and Declined Experience

**ID:** closed-beta-access/008
**Depends on:** closed-beta-access/007
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** done

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

- [x] Awaiting review, declined, suspended, and undetermined each render distinct, plain-language copy and the right controls.
- [x] The visitor's verified sign-in identity is shown, and signing out and signing in as another identity both work from the surface.
- [x] A decision change while the surface is open moves the visitor into the product (on approval) or onto the correct notice (on decline or revocation) without a re-login.
- [x] The surface performs no catalog read and grants no authenticated capability, and renders while the catalog read model is closed.
- [x] A signed-out visitor reaching the surface gets the landing page instead.
- [x] The surface meets the UI and accessibility standard at desktop and narrow widths in both themes, with correct per-state document titles and no horizontal overflow.

## Verification

Frontend tests render each state with its distinct copy and controls, prove the surface moves the visitor into the product when the decision changes without a re-login, prove sign-out works from it, prove no catalog or capability call is made, and prove the signed-out redirect. Layout and theming are checked at desktop and narrow widths with no page-level horizontal overflow. The frontend lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md`; closed-beta-access/001 (self-read contract), 004 (capability refusal codes), 006 (landing/auth-boot conventions), 007 (route, reason hand-off, gateway shell — Spec Compliance "008 handoff"); `docs/ui-layout-standard.md`, `docs/frontend-feature-baseline.md`, `docs/testing/shift-left-bdd.md`; `.tasks/messaging/_index.md` (messages are one-way — no reply thread may be promised).
- Alignment: 007's placeholder is replaced in place — same route (`app/access/page.tsx`, still server-re-resolving, never trusting the URL, same `<AccessHoldingNotice reason={route.reason} />` hand-off), same reason vocabulary. The surface is now `components/access/AccessHoldingNotice.client.tsx` composing three pieces: all copy in `lib/access-holding-content.ts` (four distinct states plus the approved moment, identity block, controls, wrong-state guidance); pure decision logic in `components/access/access-holding-presentation.ts` (live-decision merge, session observation, identity slot, controls); and the client component wiring them. The live reaction is the authenticated self-read (`api.productUserAccess.getMyAccess`) subscribed reactively inside the initialized Convex provider tree, mounted only while `auth.status === "signed_in"`; live answers win over the server-rendered reason — admitted navigates `router.replace("/")` (the root re-resolves server-side and serves the product; no re-login), a held reason swaps notice and `document.title` in place with a polite live-region announcement. Sign out (→ landing) and sign out & switch identity (logout then login from the surface) run through the existing `usePackScoutAuth` context; a settled sign-out replaces them with one sign-in action. Per-state document titles come from `generateMetadata` server-side and the title effect client-side. No catalog read, no mutation, no capability: the surface's only authenticated call is the self-read (`access-holding-surface.source.test.ts` pins `api.` references to exactly `api.productUserAccess.getMyAccess`). Signed-out visitors still get the landing (007's redirect kept; verified over HTTP).
- Verified identity sourcing: chosen per repo conventions as "what the auth provider itself exposes" — `components/auth/verified-identity.ts` extracts provider-verified attributes (linked email, else Google OAuth email; first verified wallet, casing preserved) from the Privy `user` object inside `InitializedPackScoutAuthProvider`, exposed through a new `identity` field on `PackScoutAuthValue` (null outside an established session). No Convex change: `getMyAccess` still returns only effective access; no read exposing anyone else's data exists. The surface imports nothing from `@privy-io/*`.
- Supporting changes the holding flow needed (all `apps/frontend/`):
  - `components/auth/tolerant-query.client.ts` (+`tolerant-query.test.ts`): `useQueries`-based hook returning `{data,error}` instead of throwing. Without it, 004's `BETA_ACCESS_*` refusal of `savedItems.getSavedItemIds` — subscribed by `AuthenticatedSavedItemsProvider` for every signed-in visitor — threw during render above every error boundary, crashing the app for exactly the held visitors this surface serves. `AuthenticatedSavedItemsProvider` now uses it for both session reads (`session-refusal-tolerance.source.test.ts`; stale assertion in `account-standing.test.ts` rewritten to the new truth, not deleted).
  - `requestSessionBoot` on `PackScoutAuthValue`: boots the provider without login intent (no dialog ever). The surface calls it on mount because the server verified a session but the client's returning-session hint can be missing (cleared storage), which would otherwise leave the page without its live subscription. No-op once initialized and where auth is unavailable.
- Divergences: (1) A live `undetermined` answer replaces a concrete server-rendered state (newest authoritative answer wins, uniformly) rather than being suppressed; the subscription self-corrects when resolution recovers. (2) The contact path: no product contact surface exists (landing/learn carry none, and `messaging/_index.md` forbids promising reply threads), so the wrong-state guidance names only paths that exist — check the exact signed-in address, switch identities from the surface, and a conditional "if someone invited you, they are the right person to ask" — inventing no support system. (3) 007's account-menu-note copy field is gone: the surface now carries its own sign-out/switch controls (the gateway shell's account menu remains as a second path). (4) The approved moment renders brief distinct copy ("You're in") during the sub-second navigation rather than flashing a stale notice.
- Verification (all from worktree root, exit 0): `npm run lint:frontend && npm run typecheck:frontend && npm run test:frontend && npm run build:frontend` — 317 tests passed, 0 failed, including `components/access/access-holding-presentation.test.ts` (17; the live-reaction test is "an approval arriving while the surface is open moves the visitor into the product without a re-login", plus decline/suspension arriving, no-live-answer, impossible-shape, settled-vs-booting sign-out, and controls tests), `lib/access-holding-content.test.ts` (9: distinctness, no invented promises, declined respectful/no-loop, suspended never review, undetermined temporary+retry, no backend vocabulary across every visible string, honest guidance), `components/access/access-holding-surface.source.test.ts` (9 wiring pins), `components/auth/verified-identity.test.ts` (5), `components/auth/tolerant-query.test.ts` (3), `components/auth/session-refusal-tolerance.source.test.ts` (3), unchanged `app/route-access-gate.source.test.ts` still green. `npm run scan:framework-standards:ratchet` → 0 findings, 0 new; `node scripts/check-docs.mjs` → ok (156 files). HTTP matrix against a scriptable backend stub on an isolated dev instance (own dist dir and ports; the shared 5197 lane untouched): awaiting/declined/suspended/outage each rendered its distinct title+h1; signed-out `/access` carried zero holding markup and the meta-refresh redirect; an approved cookie bounced off `/access` and the root served the product dashboard. Browser smoke (auth-unconfigured lane): 1280×800 and 375×812, light and dark — one `h1` (route-focus target), `scrollWidth === clientWidth` with zero elements past the viewport at both widths, identity panel and both controls rendered (correctly disabled while no session can be established, and out of tab order), undetermined's "Try again" link keyboard-reachable with the global 2px focus ring at 3px offset, per-state `document.title` confirmed in-tab. Environment caveat (standing since 007): exercising the live flip and the populated identity panel end-to-end needs a configured Privy app plus the Convex sync protocol, neither available locally — that path is covered by the presentation behavior tests and source wiring pins above, and belongs to 011's live verification.
