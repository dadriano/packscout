# Task: Notify Product Users of Beta Access Decisions

**ID:** messaging/006
**Depends on:** messaging/003, messaging/004, closed-beta-access/003, closed-beta-access/010
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** todo

## Objective

Someone waiting for closed-beta access finds out when an administrator decides — an email telling them they are in, or that access is not available — instead of having to keep checking the site.

## Context

The closed-beta feature deliberately left this out, noting that the product had no user-facing email infrastructure and that the waiting surface reacts to a decision live so nobody is stuck. That reasoning holds only for someone sitting on the page with it open. Realistically a person signs in once, sees they are in review, closes the tab, and never learns they were approved. This task closes that gap, and the closed-beta feature's exclusion is superseded by it.

The decision happens where an operator makes it — in the admin, through the approve and decline operations. That is also where the message is enqueued, which keeps the trigger next to the action and needs no new path from the product backend into the messaging layer.

The constraint that shapes the work is that a product identity may not have an email address at all: users sign in through a hosted wallet/social provider, and a wallet-only identity exposes no address. Having no way to reach someone is a normal state here, not an error, and must not turn an administrator's successful approval into a failed operation.

## Requirements

- Approving a waiting user enqueues an approval message; declining enqueues a decline message. Revoking an approved user does not send anything — that is an enforcement action, not an announcement.
- Automatic admission through the allowlist sends nothing: those users are admitted at sign-in and are already in the product.
- Messages go only to an address the auth provider verified. An identity with no verified address is skipped as a normal outcome, recorded so an operator can see it, and never reported as a failure of the decision.
- The decision itself is authoritative regardless of messaging: an administrator's approve or decline succeeds and takes effect even if enqueueing the message fails, and the failure is visible rather than swallowed.
- The approval message tells the person they are in and how to get to the product, in plain language, and carries no credential or sign-in token — they sign in the way they already did.
- The decline message is brief and respectful, states that access is not available, exposes no operator notes or internal reasoning, and does not invite a reply thread the product cannot service.
- Repeated or concurrent decisions do not produce repeated messages: the message is keyed to the decision transition, so approving an already-approved user sends nothing further.
- A person approved, revoked, and approved again receives a message for each genuine transition, not for the no-op repeats between them.
- Recipient addresses are personal data: they appear in the delivery queue because delivery needs them, and nowhere else — not in admin logs, metrics, or URLs.
- The messages are transactional in character: they concern an account action the person initiated by signing in, carry no promotional content, and follow the catalogue rules from messaging/003.

## User-Facing Behavior

A person signs in during the beta, sees they are in review, and closes the tab. An administrator approves them; a short email arrives saying they are in, with a link to the product. If they are declined, they get a brief note saying access is not available. If they signed in with a wallet and no email address, nothing is sent and they discover their new access the next time they visit — the outcome an administrator can see on the record.

## Interface Contract

- The admin's approve and decline operations enqueue through messaging/004 after the decision has been recorded authoritatively, using an idempotency key derived from the subject and the decision transition.
- Rendering uses the access-decision message kinds from messaging/003.
- The recipient is the verified address carried on the product-user directory record; its absence is a recorded skip, not an error.
- No new inbound surface into the product backend is introduced; the decision path already runs in the admin.

## Acceptance Criteria

- [ ] Approving a waiting user enqueues an approval message; declining enqueues a decline message; revoking and allowlist admission enqueue nothing.
- [ ] An identity with no verified address is skipped as a normal, recorded outcome, and the administrator's decision still succeeds.
- [ ] A decision succeeds and takes effect even when enqueueing fails, and the enqueue failure is visible to operators.
- [ ] Repeat or concurrent decisions produce no duplicate messages; genuine re-transitions produce one message each.
- [ ] Message content carries no credential, sign-in token, operator note, or internal reasoning.
- [ ] Recipient addresses appear only where delivery requires them, never in admin logs, metrics, or URLs.

## Verification

Admin behavior tests prove enqueueing on approve and decline, silence on revoke and allowlist admission, the skipped outcome for identities with no verified address, decision success despite enqueue failure, and idempotent behavior across repeat and concurrent decisions; rendering assertions confirm the absence of credentials and operator notes. The workspace typecheck, the services test command, and the admin test command exit 0.
