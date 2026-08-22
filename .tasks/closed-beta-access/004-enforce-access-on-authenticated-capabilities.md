# Task: Enforce Approved Access on Authenticated Capabilities

**ID:** closed-beta-access/004
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** todo

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

- [ ] Each authenticated capability refuses for awaiting-review, declined, suspended, and undetermined identities, with the reason distinguishable in the outcome.
- [ ] Each authenticated capability succeeds unchanged for an approved, unsuspended identity.
- [ ] A session established before a decline or revocation is refused on its next call.
- [ ] A refusal leaves saved data unchanged, and a later admission restores full capability with that data intact.
- [ ] With the switch off, every authenticated capability behaves exactly as it does today.
- [ ] An enumeration test proves no authenticated entry point performs its effect without passing the shared access gate.

## Verification

Product backend tests prove refusal and reason accuracy for every authenticated entry point across awaiting-review, declined, suspended, and undetermined states; success for admitted identities; that a pre-decision session gains nothing; that refusals leave data intact; both switch positions; and an enumeration test that fails if any authenticated entry point bypasses the shared gate. The workspace typecheck and the product-backend test command exit 0.
