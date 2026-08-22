# Task: Maintain the Beta Allowlist

**ID:** closed-beta-access/002
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/009
**Estimated scope:** medium
**Status:** todo

## Objective

An operator-managed allowlist of email addresses and wallet addresses admits matching identities to the closed beta automatically — at their first sign-in if the entry already exists, or the moment the entry is added if they are already waiting.

## Context

The closed beta has two ways in: an operator adds you in advance, or an operator approves you after you show up. This task builds the first one; closed-beta-access/003 builds the second.

The approved reference web app keeps a table of allowlisted email addresses that its sign-in path consults: an address on the list flips the account to active during sign-in, so invited people never wait. PackScout needs the same behavior with one adaptation — its users sign in through a hosted wallet/social provider, so an identity may present a verified email address, a verified wallet address, both, or (rarely) neither. The allowlist therefore matches on either kind of identifier.

The allowlist must be consulted during product sign-in, so it belongs with the product-user directory rather than in the admin's own store; the admin manages it through the same server-to-server operator integration it already uses to read the directory. It holds email and wallet addresses of real people, so it is privileged data with the same handling rules as the directory itself.

Two semantics are worth fixing deliberately, because getting them wrong produces support problems that are hard to see:

- Adding an entry admits people who are already waiting. An operator who adds an address and finds the person still stuck on the waiting screen has been given a broken tool.
- Removing an entry stops future automatic admission but does not throw out anyone already admitted. Revoking a specific person's access is an explicit, audited operator action (closed-beta-access/003), not a side effect of tidying a list.

## Requirements

- An allowlist entry carries at least one identifier — an email address, a wallet address, or both on the same entry — plus an optional short label for the operator's own reference, creation and update times, and which operator created it.
- Identifiers are normalized on the way in: email addresses trimmed and case-folded, wallet addresses matched case-insensitively so a checksum-cased address and a lowercase one are the same address. Matching uses the normalized form.
- Two entries cannot claim the same normalized identifier. A duplicate attempt fails with a clear, actionable outcome rather than creating a shadow entry or silently overwriting the first.
- During establishment of a sign-in (closed-beta-access/001), an identity whose **verified** identifiers match an entry is admitted immediately, with allowlist provenance recording which entry matched. Only identifiers the auth provider verified may match; a self-asserted or unverified attribute never admits anyone.
- Adding an entry immediately admits existing awaiting-review accounts that match it. The operation is bounded and idempotent, and reports how many accounts it admitted so the operator gets confirmation.
- Adding an entry does **not** overturn a declined account. An operator's explicit decline outranks a later list addition; reversing it is a deliberate operator action in closed-beta-access/003.
- Removing or editing an entry stops future automatic admission for the affected identifier and leaves already-approved accounts untouched.
- An entry may exist for an identifier that has never signed in; that person is admitted on their first sign-in with no operator involvement.
- The allowlist is reachable only through the authenticated server-to-server operator integration. Product clients, browsers, and unauthenticated callers cannot read or write it, and no part of it reaches a browser bundle. Access control is proven by tests, not assumed.
- Listing supports search by identifier, recency ordering, and bounded pagination, so the surface stays predictable as the list grows.
- Identifiers never travel in URLs, query strings, browser history, or logs — the operator integration carries them the same non-URL way the existing product-user listing does.
- Platform operators are not admitted by virtue of being operators: an operator who wants to use the product adds their own identifier to the list like anyone else. The two identity systems stay separate.

## User-Facing Behavior

Invisible to product users except in its effect: someone on the list signs in and is simply in, with no waiting screen. Operators experience this list through the admin (closed-beta-access/009).

## Interface Contract

- An allowlist entry: a stable id, an optional normalized email, an optional normalized wallet address (at least one present), an optional label, `createdAt`, `updatedAt`, and the creating operator's reference.
- An evaluation used by closed-beta-access/001's establishment: given an identity's verified identifiers, return the matching entry or nothing. A match produces an approved decision with allowlist provenance referencing the entry id.
- Privileged list, create, update, and delete operations on the operator integration surface, consumed by closed-beta-access/009. Create and update report how many waiting accounts were admitted as a result.
- Deletion of an entry never changes any existing access decision.

## Acceptance Criteria

- [ ] Entries can be created with an email, a wallet address, or both; identifiers are normalized, and a duplicate normalized identifier is rejected with a clear outcome.
- [ ] An identity with a verified matching identifier is admitted at first sign-in with allowlist provenance naming the matched entry; an unverified attribute never matches.
- [ ] Adding an entry admits matching awaiting-review accounts immediately and reports the count; a declined account is left declined.
- [ ] Removing an entry stops future automatic admission and leaves already-approved accounts admitted.
- [ ] Unauthenticated and ordinary product callers cannot read or write the allowlist; only the authenticated operator integration can.
- [ ] Listing search, recency ordering, and pagination stay within their bounds on a list large enough to page.

## Verification

Product backend tests prove normalization and duplicate rejection, verified-identifier-only matching at establishment, retroactive admission of awaiting-review accounts (and non-reversal of declined ones), removal semantics preserving existing approvals, access control on every privileged operation, and search/pagination bounds. The workspace typecheck and the product-backend test command exit 0.
