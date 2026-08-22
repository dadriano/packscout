# Task: Issue and Redeem One-Time Email Links

**ID:** messaging/008
**Depends on:** messaging/003, messaging/004
**Blocks:** messaging/009, messaging/010
**Estimated scope:** large
**Status:** todo

## Objective

PackScout can prove that whoever clicked a link in an email controls that mailbox — a purpose-scoped, single-use, expiring token mechanism that operator password reset and operator provisioning both build on.

## Context

Admin operators are provisioned by another administrator setting a password for them, and there is no way for an operator to recover their own account. Both gaps need the same thing underneath: a link mailed to an address, redeemable exactly once, that proves control of the mailbox and authorizes one specific action.

This is the part of the feature where mistakes are expensive, so the design follows the approved reference platform's shape closely: tokens carry a purpose so a reset link cannot be replayed as a provisioning link, they expire, they are single-use, they are stored hashed so a database read does not yield usable credentials, and issuance is rate-limited per address and per source. The reference also splits the token into a lookup part and a secret part, so verification is a direct lookup followed by a constant-time comparison rather than a scan.

The other half is not leaking who exists. A reset request for an unknown address must be indistinguishable from one for a known address — same response, same timing characteristics, same wording — or the endpoint becomes an operator directory for anyone who wants one.

## Requirements

- A token is issued for a specific purpose and a specific subject. A token issued for one purpose is rejected for any other, and a token for one subject can never act on another.
- Tokens expire at a configured, purpose-specific lifetime, and an expired token is rejected with the same outcome as an unknown one.
- Redemption is single-use and atomic: two concurrent redemptions of the same token result in exactly one success, and a redeemed token cannot be reused even if redemption's follow-on work fails.
- Token material is stored so that a database read cannot yield a usable token: the secret portion is stored only as a hash, and comparison is constant-time. The usable token exists only in the message that was sent.
- The token value never appears in a log, metric, error payload, audit record, or admin surface, and never in a URL that PackScout itself records server-side beyond the redemption request.
- Issuing invalidates prior outstanding tokens for the same subject and purpose, so a reissued link supersedes an older one rather than leaving several live.
- Issuance is rate-limited per address and per requesting source, with a bounded, non-enumerating response when the limit is hit.
- Requests for an unknown or ineligible subject produce the same outcome, wording, and observable timing as requests for a valid one. No endpoint in this mechanism reveals whether an account exists.
- Redemption verifies the subject's current eligibility at redemption time, not at issuance: a subject who was disabled between issuance and redemption is refused.
- The message carrying the link renders through messaging/003 and is enqueued through messaging/004 with the same durability and retry guarantees as any other message; a delivery failure does not consume the token.
- Tokens and their state are pruned on a schedule after expiry, and pruning never deletes a token that is still live.
- Every issuance and every redemption attempt — successful, expired, mismatched-purpose, already-used, or rate-limited — produces an audit record identifying the subject, purpose, outcome, and time, and never the token value.

## User-Facing Behavior

None on its own. Experienced through the flows built on it: a link arrives, it works once, it stops working after use or after its lifetime, and asking for one for an address that does not exist looks exactly like asking for one that does.

## Interface Contract

- An issuance operation taking a purpose and a subject, returning the redeemable token to the caller for inclusion in the message it enqueues — and returning nothing that could be logged as a credential.
- A verification-and-redemption operation taking a purpose and a presented token, returning either the resolved subject or a single indistinguishable rejection outcome for every failure mode (unknown, expired, wrong purpose, already used, ineligible subject).
- Purpose-specific lifetimes and rate limits are server-side configuration.
- Consumers: messaging/009 (operator password reset) and messaging/010 (operator provisioning). Adding a purpose means adding a purpose and its lifetime, not a parallel token mechanism.

## Acceptance Criteria

- [ ] A token redeems exactly once for its own purpose and subject, and is rejected for any other purpose or subject.
- [ ] Expired, unknown, already-used, wrong-purpose, and ineligible-subject redemptions all produce the same indistinguishable rejection.
- [ ] Two concurrent redemptions of the same token yield exactly one success.
- [ ] Stored token material cannot be used to redeem; comparison is constant-time.
- [ ] Issuing supersedes prior outstanding tokens for the same subject and purpose.
- [ ] Issuance is rate-limited per address and per source, and a limited request does not reveal whether the account exists.
- [ ] Requests for unknown and known subjects are indistinguishable in outcome, wording, and observable timing.
- [ ] A delivery failure does not consume the token, and the token value appears in no log, metric, audit record, or admin surface.
- [ ] Every issuance and redemption attempt is audited with subject, purpose, outcome, and time, and no token value.

## Verification

Tests prove single-use redemption under concurrency, purpose and subject scoping, uniform rejection across every failure mode, hashed-at-rest storage and constant-time comparison, supersession on reissue, per-address and per-source rate limiting, non-enumeration for unknown subjects including timing characteristics, eligibility rechecked at redemption, token survival across delivery failure, pruning that spares live tokens, and audit records free of token values. The workspace typecheck and the services test command exit 0.
