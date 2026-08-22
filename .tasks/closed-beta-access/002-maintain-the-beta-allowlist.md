# Task: Maintain the Beta Allowlist

**ID:** closed-beta-access/002
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/009
**Estimated scope:** medium
**Status:** done

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

- [x] Entries can be created with an email, a wallet address, or both; identifiers are normalized, and a duplicate normalized identifier is rejected with a clear outcome.
- [x] An identity with a verified matching identifier is admitted at first sign-in with allowlist provenance naming the matched entry; an unverified attribute never matches.
- [x] Adding an entry admits matching awaiting-review accounts immediately and reports the count; a declined account is left declined.
- [x] Removing an entry stops future automatic admission and leaves already-approved accounts admitted.
- [x] Unauthenticated and ordinary product callers cannot read or write the allowlist; only the authenticated operator integration can.
- [x] Listing search, recency ordering, and pagination stay within their bounds on a list large enough to page.

## Verification

Product backend tests prove normalization and duplicate rejection, verified-identifier-only matching at establishment, retroactive admission of awaiting-review accounts (and non-reversal of declined ones), removal semantics preserving existing approvals, access control on every privileged operation, and search/pagination bounds. The workspace typecheck and the product-backend test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` ("Ported from the approved reference web app and admin"; operators are not admitted by being operators); closed-beta-access/001's Spec Compliance — this task fills in the `decidedBy: "allowlist"` + `allowlistEntryId` provenance 001 reserved; closed-beta-access/003 (operator decisions outrank the list; reversing a decline is 003's job) and 009 (the admin consumer of this integration surface).
- Alignment: `betaAllowlistEntries` (schema) stores a normalized email, a verbatim-cased wallet address with a lowercase `walletAddressKey` for case-insensitive matching (the directory's `productUserWalletAddressKey` convention), an optional label, `createdAt`/`updatedAt`, and `createdByOperatorId`, indexed `by_email`, `by_wallet_address_key`, and `by_updated_at`. `convex/betaAllowlistRecords.ts` is the pure shared module — normalization reuses the directory's email/wallet normalizers so the list and the records can never disagree about "the same address"; fixed-string refusals; `findBetaAllowlistMatch` (email consulted before wallet for determinism); `betaAllowlistApprovedDecision`. `convex/betaAllowlist.ts` registers the internal-only operations: `createEntry` and `updateEntry` return the entry plus `admittedCount` from the bounded, idempotent retroactive admission of matching awaiting-review accounts (including records that predate the closed beta; declined and operator-approved records are never touched); `removeEntry` deletes the entry and changes no access decision; `listEntriesPage` orders by `updatedAt` recency, searches identifier prefixes case-insensitively through bounded index scans, and pages with the directory's cursor discipline. Establishment-time matching lives in the one shared write path, `establishProductUserRecord` (productUsers.ts): a first contact whose verified identifiers match an entry is inserted approved with allowlist provenance naming the entry id, and an existing awaiting-review record re-consults the list on its merged verified identifiers, so an entry added while someone waited — or an identifier the provider newly verified — admits them on that contact. Approved and declined records never re-evaluate. Matching consumes only Convex-verified identity attributes; no function argument exists through which a caller could assert an identifier. The surface is reachable only through four POST routes on the admin-integration HTTP router (`/admin/beta-allowlist/list|create|update|remove`), authenticated with the same `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` bearer secret as the directory reads — they are one integration, and the `convex.config.ts` comment now says so. Identifiers travel only in JSON bodies, never in URLs, query strings, logs, or error payloads.
- Divergences: (1) A duplicate identifier refuses with a kind-specific code (`BETA_ALLOWLIST_DUPLICATE_EMAIL` / `BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS`, HTTP 409) that names which identifier kind collided but never the value — actionable without echoing personal data. (2) Updating or removing a vanished entry returns `{ entry: null }` / `{ removed: false }` (the directory's null-record convention) instead of refusing, so repeated operator actions converge; only a malformed entry reference refuses. (3) A change-free update re-runs the admission scan (bounded at 100 records per identifier), making update the idempotent re-sync tool; `updatedAt` bumps only on real edits. (4) Listing recency is `updatedAt` descending — equal to `createdAt` until an edit — so a just-edited entry surfaces first. (5) Decision maintenance is switch-independent: while `PACKSCOUT_CLOSED_BETA` is off a matching sign-in still records the allowlist-approved decision, so invitations recorded during a public phase are honored when the beta turns on.
- Deferred to consumers: the admin allowlist screen, its permission gating, and restating null-entry results as "not found" (009); operator decide/reverse operations including reversing a decline (003); enforcement reads (004/005).
- Verification: `npm run typecheck:convex && npm run test:convex` → exit 0 (25 files, 207 tests passed; 23 in `convex/betaAllowlist.test.ts`, all pre-existing suites unchanged and green). `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new findings. `node scripts/check-docs.mjs` → ok, 155 markdown files. `npm run typecheck:frontend` → exit 0 (generated-api consumers unaffected).
