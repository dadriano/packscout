# Task: Welcome an Admitted User on First Sign-In

**ID:** messaging/007
**Depends on:** messaging/003, messaging/004, closed-beta-access/001
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** todo

## Objective

The first time an admitted user actually gets into PackScout, they receive one welcome message — once, ever — orienting them around what the product does.

## Context

Someone admitted through the allowlist never gets an approval email: they sign in and they are simply in (messaging/006 deliberately sends nothing for that path). Without a welcome, a beta invitee's entire onboarding is a page they landed on. This is the message that acknowledges them.

The trigger is the first *admitted* session, not the first sign-in. Someone who signs in while awaiting review has not arrived yet; welcoming them before they are let in would be wrong and confusing.

The wrinkle is where that fact lives. Sign-ins are recorded by the product backend, which is a different runtime from the delivery layer, and the messaging queue lives with the platform's other operational records. Rather than opening a new inbound path into the delivery layer, the durable marker lives with the user's directory record and the dispatcher discovers pending welcomes through the server-to-server operator integration that already exists for reading that directory. The marker is what makes "once, ever" true across restarts, retries, and duplicate discovery.

## Requirements

- A welcome is triggered by the first session in which the user's effective access is admitted — not by their first sign-in, and not by an access decision on its own.
- Exactly one welcome is ever sent per identity. A durable marker on the user's record records that it has been claimed, and the marker is set in a way that concurrent discovery cannot produce two messages.
- A user who is admitted, revoked, and admitted again is not welcomed a second time.
- Users who were already using the product before this task ships are not welcomed retroactively; only identities newly reaching their first admitted session receive one.
- An identity with no verified email address is marked as not needing a welcome and never retried, recorded as a normal skip.
- Discovery is bounded and idempotent: each dispatcher pass claims a bounded number of pending welcomes, and a pass that fails partway leaves no identity both unclaimed and unsent, or claimed and never sent, in a way that a subsequent pass cannot resolve.
- Enqueueing failures do not lose the welcome: the marker is only settled once the message is durably enqueued, so a crash between claiming and enqueueing results in a retry rather than a silent skip.
- Nothing about the welcome affects sign-in: a user's session, access, and capabilities are entirely unaffected by whether the message was sent, enqueued, or failed.
- The message orients rather than sells: what PackScout does, where to start, what the numbers mean, and the fact that this is a closed beta. It is transactional in character, carries no promotional offers, and follows the catalogue rules from messaging/003.
- The message contains no credential, no sign-in link carrying a token, and no personal data beyond addressing the recipient.
- Welcome sending is independently switchable off without affecting any other message kind.

## User-Facing Behavior

An invited collector is added to the allowlist, signs in for the first time, and lands in the product. Shortly afterwards a short welcome arrives explaining what they are looking at and where to start. They never receive it again, no matter how many times they sign in, and someone still awaiting review never receives it at all.

## Interface Contract

- A durable per-identity welcome marker on the product-user directory record with states covering: not yet due, claimed, sent, and not applicable (no verified address).
- A bounded dispatcher pass that discovers identities at their first admitted session through the existing server-to-server operator integration, claims them, and enqueues through messaging/004 with an idempotency key derived from the identity.
- Rendering uses the welcome message kind from messaging/003.
- No new inbound surface into the delivery layer, and no change to the sign-in path's behavior or latency.

## Acceptance Criteria

- [ ] A welcome is enqueued at the first admitted session and never before admission.
- [ ] Exactly one welcome is ever enqueued per identity, including under concurrent discovery, and re-admission after revocation sends none.
- [ ] Identities already active before this ships are not welcomed retroactively.
- [ ] An identity with no verified address is recorded as not applicable and never retried.
- [ ] A crash between claiming and enqueueing results in a later retry, not a silent skip or a duplicate.
- [ ] Sign-in behavior, latency, access, and capabilities are unchanged regardless of welcome outcome.
- [ ] The message carries no credential, tokenized link, or promotional content.
- [ ] Welcome sending can be switched off without affecting other message kinds.

## Verification

Tests prove the first-admitted-session trigger, single-send under concurrent discovery, no re-send after revocation and re-admission, no retroactive welcome for pre-existing identities, the no-address skip, crash-between-claim-and-enqueue recovery, bounded discovery passes, and that sign-in is unaffected by every welcome outcome. The workspace typecheck, the services test command, and the product-backend test command exit 0.
