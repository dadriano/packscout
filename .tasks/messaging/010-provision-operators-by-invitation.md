# Task: Provision Operators by Invitation

**ID:** messaging/010
**Depends on:** messaging/008
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** done

## Objective

An administrator creates an operator account by inviting an email address, and the new operator sets their own password through a mailed link — so a working password never has to be chosen by one person and communicated to another.

## Context

Today creating an operator means an administrator types a password into the create-operator form and then tells the new operator what it is. That password travels through some chat or email thread, is known to two people, and is often never changed. For accounts that administer the data pipeline, that is the weakest link in the admin's otherwise careful authentication.

The mechanism is already built by messaging/008 and already exercised by messaging/009; this task is the provisioning flow on top of it. The interesting design question is what an invited-but-not-yet-activated operator *is*: the account has to exist so it can hold a role and appear in the operators list, but it must not be usable until someone proves control of the mailbox and sets a password.

## Requirements

- An administrator can create an operator by supplying an email address and a role, without setting a password. An invitation message with a single-use link is enqueued as part of that creation.
- The created account exists in a clearly labelled pending state: it appears in the operators list with its role and its pending status, and it cannot sign in until activation.
- A pending account cannot authenticate by any route, and no password reset or other flow can turn it into a usable account without redeeming its invitation.
- Redeeming the invitation presents a set-password screen validated against the admin's existing password rules, and on success the account becomes active and can sign in.
- Invitations expire on a purpose-specific lifetime, are single-use, and can be reissued by an administrator, which supersedes any outstanding invitation for that account.
- An administrator can see whether an invitation is outstanding, when it was sent, and whether it has expired, and can cancel a pending account entirely — which invalidates its outstanding invitation.
- Reissuing and cancelling are guarded by the same permission that governs operator management today, and both are audited with acting operator, target, action, and outcome.
- Redeeming an invitation for an account that has since been cancelled, or whose invitation was superseded, produces the same plain invalid-link outcome as any other refusal, without revealing the account's existence or state.
- Administrator-set passwords remain possible only where the admin already supports them for existing accounts; this task does not remove an existing capability, but invitation becomes the path for new accounts.
- The invitation message states who invited them, what PackScout's admin is, and that the link is single-use and time-limited. It carries no password, and no credential beyond the one-time link.
- Every state — pending, invitation expired, activated, cancelled — is visible in the operators list using the admin's existing status patterns, distinguishable at a glance from the enabled and disabled states that already exist.
- No token, link, or password appears in any log, metric, audit record, or admin surface.

## User-Facing Behavior

An administrator opens the operators area, invites a colleague by address and role, and sees the new account listed as pending with an invitation sent. The colleague receives a message naming who invited them and a single link, sets their own password, and signs in. The administrator sees the account flip to active. If the invitation goes stale, the administrator reissues it or cancels the account; a stale or cancelled link shows the same plain "no longer valid" screen.

## Interface Contract

- Operator creation accepts an email address and role without a password and enqueues an invitation through messaging/004, using the provisioning purpose from messaging/008.
- A pending account state is added to the operator account model and is rejected by every authentication path.
- Protected reissue and cancel operations guarded by the existing operator-management permission.
- Redemption uses the messaging/008 verification-and-redemption operation and the admin's existing password rules; it introduces no new password policy and no new session mechanism.
- The invitation message kind and rendering belong to messaging/003.

## Acceptance Criteria

- [x] An administrator can create an operator with only an address and a role, and an invitation is enqueued.
- [x] A pending account appears with its role and pending status and cannot authenticate by any route until activation.
- [x] Redeeming a valid invitation sets a password against the existing rules and activates the account for sign-in.
- [x] Invitations are single-use and expiring; reissue supersedes outstanding invitations; cancel invalidates them.
- [x] Redemption for a cancelled, superseded, or expired invitation shows the same plain invalid outcome without revealing account state.
- [x] Reissue and cancel are permission-guarded and audited; anonymous and unauthorized requests receive the standard outcomes.
- [x] Pending, expired-invitation, active, and cancelled states are distinguishable in the operators list from the existing enabled and disabled states.
- [x] No token, link, or password appears in any log, metric, audit record, or admin surface.

## Verification

Admin route behavior tests prove invitation-based creation, that pending accounts are refused by every authentication path, activation through redemption, single-use and expiry, reissue supersession, cancellation invalidating outstanding invitations, the permission matrix for reissue and cancel, uniform invalid-link outcomes, and audit records free of secrets; page tests cover the operators list states and the set-password screen. The admin lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: none (no `tech-*.md` or `ux-*.md` companions in this feature)
- Alignment: An invited-but-not-yet-activated account is modelled as a real operator row in a new `pending` state holding **no credential at all** — `operators.password_hash` becomes nullable, and a database check constraint (`operators_active_requires_credential`) makes an active account without a credential impossible rather than merely unlikely. Cancellation is a second new terminal state, `cancelled`, kept distinct from `disabled` so the ledger tells a withdrawn invitation apart from an account that once worked. Both are in the shared state vocabulary but neither is assignable through the update endpoint: `operatorAssignableStates` still holds only `active` and `disabled`, so `pending` comes only from inviting and `cancelled` only from cancelling. Rejection of pending accounts is enforced at two independent layers — every service authentication path already keys on `state === "active"` (login, session resolution, session bootstrap, reset issuance, reset eligibility, reset completion), and the repository's `updateOperator` refuses any target in `pending` or `cancelled` at the data edge, which is what closes the reset-and-administrator-edit routes into usability. A dedicated `activateInvitedOperator` transition, guarded on `pending` inside its own UPDATE, is the only way out of the pending state, so two concurrent redemptions resolve to one activation at the database. Issuance, supersession, single use, expiry, hashing, rate limiting, and the one uniform rejection all belong to messaging/008; reissue supersedes inside the same write that records the new token, and cancellation moves the account out of `pending` before superseding its links, so both ends of the refusal agree. Every dead link — cancelled, superseded, expired, reused, malformed, unknown, or bound to another subject — collapses into one `OPERATOR_INVITATION_LINK_INVALID_MESSAGE` with an identical body. Reissue and cancel sit behind the same `operators:manage` permission, trusted-Origin, and CSRF discipline as every other operator mutation, and both emit auth-audit entries (`operator.invitation_reissue`, `operator.invitation_cancel`) carrying acting operator, target, action, and outcome. Administrator-set passwords remain available for existing accounts through `updateOperatorRequestSchema.password`; creation with a password is not merely unused but refused by the strict invite schema.
- Divergences: (1) The spec names `pending` as the one added state; **`cancelled` was added alongside it** because acceptance criterion 7 requires cancelled accounts to be distinguishable in the list from enabled and disabled, which a delete or a reuse of `disabled` cannot provide. (2) **Creation is not one atomic transaction.** The account row is written first, then the token and its outbox intent land together; if that second step fails the route compensates by cancelling the account and superseding its links, and answers 503. The tree is therefore always in one of two honest states — pending with an outstanding invitation, or cancelled — but the compensation is a rollback rather than a single commit. (3) Reissue is exposed as `POST /api/operators/:id/invitation` and cancel as `DELETE` on the same path, rather than as states of the existing PATCH, so that an ordinary update can never be the vehicle for either.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin && npm run typecheck:services && npm run test:services && npm run lint:services && npm run typecheck:contracts && npm run test:contracts && npm run check:prisma && npm run test:database` → exit 0 (admin 320, services 589, contracts 176, database 159; 24 tests for this task: 7 admin route behavior, 5 invitation-journey behavior, 6 accept-invitation page, 2 ledger page, 2 contracts, plus 6 auth-service and 4 database integration). `npm run scan:framework-standards:ratchet` → 0 findings, 0 new. `node scripts/check-docs.mjs` → ok. A live browser pass was performed against a migrated database and a seeded administrator: the accept-invitation form and invalid-link states at 1280px and 375px in both themes with no horizontal overflow, and the operators ledger showing four simultaneously distinguishable badges — `admin-status--ready` Active, `admin-status--neutral` Cancelled, `admin-status--danger` Invitation expired, `admin-status--pending` Invitation sent — produced by real invite, cancel, and expiry operations through the running API, with three `operator_invitation` intents in the outbox and every pending row carrying a null credential.
