# Task: Enforce Approved Access on Authenticated Capabilities

**ID:** closed-beta-access/004
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** done

## Objective

While an identity is not admitted to the beta, every authenticated product capability fails closed — checked against the authoritative record at request time, so a session that predates the decision gains nothing.

## Context

Gating pages is not gating a product. The authenticated capabilities live in the product backend and are callable directly by anything holding a valid provider token, so the beta gate has to be enforced there too, not only in the browser.

Today those capabilities are saving and unsaving repacks and collectibles and reading one's own saved items. The point of this task is not those three operations in particular — it is making "resolve effective access first" the default shape of every authenticated entry point, so a capability added next month cannot quietly skip the gate.

This composes with, rather than replaces, suspension enforcement (admin-tools/005). Effective access (closed-beta-access/001) already folds suspension in; what this task adds is that the folded answer is consulted, and that the refusal is specific enough for the frontend to say the right thing to the person — "your request is under review" and "your account is suspended" are different sentences and must not be collapsed into a generic error.

## Requirements

- Every authenticated entry point resolves effective access at request time from the authoritative record. A token or session established before a decision changed carries no privilege from that earlier state.
- A refusal is a stable, distinguishable outcome the frontend can map to the correct notice — awaiting review, declined, and suspended are separately identifiable, and all three are distinguishable from an ordinary authentication failure.
- An undetermined resolution (the record could not be established or read) refuses. Nothing anywhere converts undetermined into admitted.
- Reading one's own saved items is an authenticated capability and is gated too: during the closed beta an unadmitted account has no product capabilities. Their stored data is untouched by the refusal.
- A refusal never deletes or mutates saved items, and admission later restores every capability with the data intact.
- While the beta switch is off, the authenticated capabilities behave exactly as they do today, with no added refusals and no behavior change for existing users.
- The gate is structural, not per-call diligence: authenticated entry points share one enforcement boundary, and a test enumerates the authenticated entry points and proves none of them reaches its effect without passing through it. Adding a new capability without the gate must fail that test.
- Refusal payloads carry no personal data, no catalog content, and no internal detail beyond the stable reason code.

## User-Facing Behavior

An unadmitted signed-in visitor cannot save, unsave, or list saved items; the product shows the notice matching their actual state (closed-beta-access/008) rather than a generic failure. An admitted, unsuspended user notices nothing different. A user revoked mid-session loses these capabilities on their very next action, without having to sign out.

## Interface Contract

- Every authenticated capability consults the effective-access resolution from closed-beta-access/001 before performing any effect.
- Refusals surface a stable reason — awaiting review, declined, suspended, or undetermined — that closed-beta-access/008 maps to user-facing copy.
- No change to the shape or semantics of the capabilities themselves when access is admitted.

## Acceptance Criteria

- [x] Each authenticated capability refuses for awaiting-review, declined, suspended, and undetermined identities, with the reason distinguishable in the outcome.
- [x] Each authenticated capability succeeds unchanged for an approved, unsuspended identity.
- [x] A session established before a decline or revocation is refused on its next call.
- [x] A refusal leaves saved data unchanged, and a later admission restores full capability with that data intact.
- [x] With the switch off, every authenticated capability behaves exactly as it does today.
- [x] An enumeration test proves no authenticated entry point performs its effect without passing the shared access gate.

## Verification

Product backend tests prove refusal and reason accuracy for every authenticated entry point across awaiting-review, declined, suspended, and undetermined states; success for admitted identities; that a pre-decision session gains nothing; that refusals leave data intact; both switch positions; and an enumeration test that fails if any authenticated entry point bypasses the shared gate. The workspace typecheck and the product-backend test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` ("The gate is enforced in three places"); closed-beta-access/001's Spec Compliance (`resolveProductUserEffectiveAccess` is the only admission answer; the reason vocabulary); 003 (revocation bites on the very next request); admin-tools/005's suspension posture as carried by `requireActiveProductUserStanding` and `productUserStanding.test.ts`; 005 and 008 as the neighbouring enforcement site and the refusal-code consumer.
- Alignment: `convex/productUserCapabilityGate.ts` is the one shared boundary. `requireAdmittedProductUser(ctx, capability)` acquires the identity (`AUTH_REQUIRED` / `AUTH_IDENTITY_INVALID` stay ordinary authentication failures), re-resolves effective access from the authoritative record inside the request's own transaction via `resolveProductUserEffectiveAccess` — composing switch, admission, and standing; no rule re-derived — and refuses an unadmitted resolution with a stable, fixed-message code per reason: `BETA_ACCESS_AWAITING_REVIEW`, `BETA_ACCESS_DECLINED`, `ACCOUNT_SUSPENDED` (deliberately the shared suspended code from `@packscout/contracts`, so suspension is one outcome in both switch positions), `BETA_ACCESS_UNDETERMINED`. `admitted: true` pairs only with `approved` at the type level, so undetermined can never be admitted. All three saved-item entry points (`getSavedItemIds`, `setSavedRepack`, `setSavedCollectible`) pass through the gate before any validation or effect; reading one's own saved items is gated while the beta is on, and no refusal path reaches a write, so admission later finds every row intact. While the switch is off the resolution admits everyone and the gate preserves exactly today's posture per capability: `PRODUCT_USER_WRITE_CAPABILITY` keeps the legacy standing check (suspended writes still refuse `ACCOUNT_SUSPENDED`), `PRODUCT_USER_READ_CAPABILITY` refuses nothing (suspension never hides what an account owns), and no directory read is added to the read path. The gate is structural: identity acquisition is confined (`ctx.auth` only in `productUsers.ts` and 005's read-authorization boundary; `requireProductUserIdentity` reachable only from the access-path modules and the gate), and the enumeration suite in `convex/productUserCapabilityGate.test.ts` source-scans every non-generated module, pins the access-path registration inventories, asserts the documented exemption list (`PRODUCT_USER_ACCESS_PATH_EXEMPT_ENTRY_POINTS`) equals the identity-requiring registrations exactly, requires every gated entry point to call the gate before its first `ctx.db` reference, and fails the build for any authenticated entry point that skips the boundary — with liveness assertions so regex drift cannot make the scan pass vacuously.
- Access-path exemptions (documented with rationale in the gate module): `establishAccess` and `recordSignIn` (gating establishment would refuse the very contact that creates the record under review — permanent lockout), `getMyAccess` (the self-read 007/008 render notices from; it states only the fact a refusal states), and `getMyStanding` (the pre-beta self-status read behind the suspension notice; strictly less information than `getMyAccess`, same class — added to the three the plan named, since it exists and had to be classified). `getGateStatus` is not exempt because it is not authenticated: it consults no identity.
- Divergences: (1) The refusal codes live in the gate module, not `packages/contracts` (outside this task's write scope); 008 should map the literal strings the way `access-gate.server.ts` maps `AUTH_REQUIRED`, or a later change can hoist them into contracts beside `PRODUCT_USER_SUSPENDED_ERROR_CODE`. (2) `savedItems.ts` no longer raises its own `AUTH_REQUIRED`/`AUTH_IDENTITY_INVALID`: those come from the shared vocabulary in `productUserRecords.ts` — same codes, shared message text. (3) The enumeration test also classifies 005's `publicCatalogReadAccess.ts` as the second legitimate identity consumer (a sibling read-only boundary composing the same resolution, returning no subject) and forbids its helpers from authorizing any mutation or action, keeping the two gates' jurisdictions disjoint. (4) Suspended-and-declined refuses `BETA_ACCESS_DECLINED`, inheriting 001's composed precedence (decline is the operative reason until the account would otherwise be in).
- Deferred to consumers: mapping the four codes to distinct notices (008); the catalog read model's own closure (005); operator decisions that flip the resolutions this gate consults (003/009/010).
- Verification: `npm run typecheck:convex && npm run test:convex` → exit 0 (28 files, 251 tests; 12 in `convex/productUserCapabilityGate.test.ts` covering all four refusal reasons on every capability, admitted success with today's exact shapes, decline/revoke/re-approve against a pre-decision session with rows proven byte-identical, the off→on session flip, both switch positions including legacy suspension and duplicate-record outcomes, and the four-part enumeration suite; pre-existing `savedItems.test.ts` and `productUserStanding.test.ts` unchanged and green). `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new. `node scripts/check-docs.mjs` → ok, 156 markdown files. `npm run typecheck:frontend` → exit 0.
