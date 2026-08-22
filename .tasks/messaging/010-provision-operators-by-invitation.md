# Task: Provision Operators by Invitation

**ID:** messaging/010
**Depends on:** messaging/008
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** todo

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

- [ ] An administrator can create an operator with only an address and a role, and an invitation is enqueued.
- [ ] A pending account appears with its role and pending status and cannot authenticate by any route until activation.
- [ ] Redeeming a valid invitation sets a password against the existing rules and activates the account for sign-in.
- [ ] Invitations are single-use and expiring; reissue supersedes outstanding invitations; cancel invalidates them.
- [ ] Redemption for a cancelled, superseded, or expired invitation shows the same plain invalid outcome without revealing account state.
- [ ] Reissue and cancel are permission-guarded and audited; anonymous and unauthorized requests receive the standard outcomes.
- [ ] Pending, expired-invitation, active, and cancelled states are distinguishable in the operators list from the existing enabled and disabled states.
- [ ] No token, link, or password appears in any log, metric, audit record, or admin surface.

## Verification

Admin route behavior tests prove invitation-based creation, that pending accounts are refused by every authentication path, activation through redemption, single-use and expiry, reissue supersession, cancellation invalidating outstanding invitations, the permission matrix for reissue and cancel, uniform invalid-link outcomes, and audit records free of secrets; page tests cover the operators list states and the set-password screen. The admin lint, typecheck, test, and build commands exit 0.
