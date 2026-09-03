# Task: Issue and Redeem One-Time Email Links

**ID:** messaging/008
**Depends on:** messaging/003, messaging/004
**Blocks:** messaging/009, messaging/010
**Estimated scope:** large
**Status:** done

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

- [x] A token redeems exactly once for its own purpose and subject, and is rejected for any other purpose or subject.
- [x] Expired, unknown, already-used, wrong-purpose, and ineligible-subject redemptions all produce the same indistinguishable rejection.
- [x] Two concurrent redemptions of the same token yield exactly one success.
- [x] Stored token material cannot be used to redeem; comparison is constant-time.
- [x] Issuing supersedes prior outstanding tokens for the same subject and purpose.
- [x] Issuance is rate-limited per address and per source, and a limited request does not reveal whether the account exists.
- [x] Requests for unknown and known subjects are indistinguishable in outcome, wording, and observable timing.
- [x] A delivery failure does not consume the token, and the token value appears in no log, metric, audit record, or admin surface.
- [x] Every issuance and redemption attempt is audited with subject, purpose, outcome, and time, and no token value.

## Verification

Tests prove single-use redemption under concurrency, purpose and subject scoping, uniform rejection across every failure mode, hashed-at-rest storage and constant-time comparison, supersession on reissue, per-address and per-source rate limiting, non-enumeration for unknown subjects including timing characteristics, eligibility rechecked at redemption, token survival across delivery failure, pruning that spares live tokens, and audit records free of token values. The workspace typecheck and the services test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md`; messaging/003 (its operator renderers take an opaque rooted link path — this task builds that path and the renderers never see the token separately; both catalogue files untouched) and messaging/004 (the durable enqueue this mechanism composes with; outbox internals untouched — the one export it already provided for this task, transaction-scoped `enqueueEmailMessageIntent`, is exercised in tests exactly as its doc comment intended); the consumer specs messaging/009 and /010 for the purposes, flows, and admin-visibility needs; `packages/services/src/auth-service.ts` and `apps/admin/server/auth/crypto.ts` for the platform's digest, rate-limit, and audit conventions.
- Alignment: the mechanism lives in `packages/services/src/email-links/` over one new table. **Split token:** a token is `selector.verifier` — 16 random bytes and 32 random bytes, base64url — with the selector stored plaintext and unique, and the verifier stored only as a purpose-separated HMAC-SHA256 digest under a ≥32-byte secret (`node:crypto`, no new dependency), so a database read yields nothing redeemable; the usable composite exists only in the issued link. Verification is an indexed lookup plus a `timingSafeEqual` comparison, and because the purpose is bound into the MAC input, a cross-purpose presentation fails the same comparison the same way as a wrong verifier. **Uniform rejection:** every redemption failure — malformed, unknown, wrong verifier, wrong purpose, expired, superseded, already used, ineligible subject, and the concurrent-race loser — returns the single frozen `EMAIL_LINK_REJECTION` value (one object, not one shape), and unknown/malformed presentations still perform one verifier comparison against a construction-time dummy digest. **Single-use atomicity** is database-level: consumption is one guarded UPDATE (`redeemed_at is null and superseded_at is null and expires_at > now and purpose = presented`), so exactly one of any number of concurrent redemptions wins, and nothing ever clears `redeemed_at`. **Supersession** happens inside issuance's transaction under a per-subject-and-purpose advisory lock; `greatest(issued_at, now)` keeps the settled-after-issued CHECK true under cross-writer clock skew. **Eligibility** is a caller-supplied predicate consulted at redemption time, after verification and before consumption, so a disabled subject is refused with the uniform rejection and the token is not spent. **Non-enumeration:** `requestIssuance` runs the identical sequence for known, unknown, invalid-address, and rate-limited requests — resolve once, record both throttle scopes, generate and digest one token — returning the same `{ status: "accepted" }` shape, with persistence the only difference; rate limiting rides the existing `auth_rate_limits` buckets keyed by HMAC (no raw address or network identifier is ever stored), counting every request per normalized address and per source with purpose-specific window, maximum, and block. **Audit:** every issuance and redemption attempt writes one `audit_events` row (action `email_link.issue`/`email_link.redeem`, subject, purpose, closed reason word, outcome success/failure/blocked, time) through a sink that structurally refuses free text, so token material cannot reach the ledger; tests also capture the console and inventory every audit field. **Delivery decoupling:** issuance composes with the outbox in one commit (both-or-neither), a recorded failed delivery attempt leaves the token redeemable, and only redemption consumes. **Pruning** deletes only rows whose expiry lies at or before the cutoff, bounded per pass, with a ready-made `RetentionRecordPruner` (`createEmailLinkTokenPruner`, kind `email_link_tokens`, default 30-day retention). Purposes, lifetimes (reset 1h, invitation 7d), and rate limits are server-side configuration resolved once from documented `PACKSCOUT_EMAIL_LINK_*` variables that fail closed on invalid values; adding a purpose means adding a purpose word, its lifetime, its redemption path, and its audit subject type. Migration `20260823010000_email_link_tokens` follows the outbox conventions (preamble, CHECK constraints, named indexes), with the schema-parity manifest regenerated from the migrated catalog and `EXPECTED_MIGRATIONS`/`EXPECTED_TABLE_COUNT` extended.
- Divergences: (1) The mailed link necessarily exists inside the outbox intent's stored rendering input until the message is delivered and its history pruned — the same content as the recipient's mailbox copy, per messaging/003's opaque-link contract; the token *store* holds only selector and hash, and no log, metric, error, or audit record carries token material. (2) Registering the pruner with the worker's retention cycle is composition in `apps/worker`, owned by the follow-on wiring (messaging/012); the pruner factory and its never-deletes-live guarantee ship and are proven here. (3) Redemption-time rate limiting is deliberately absent — the spec limits issuance; redemption is guarded by single-use, expiry, and 256-bit verifiers. (4) `issue()` (known subject, explicit `rate_limited` result) and `requestIssuance()` (uniform outcome) are two entry points over one path, because 010's authenticated reissue may tell its administrator the truth while 009's unauthenticated endpoint must not.
- Verification: `npm run typecheck:services`, `npm run typecheck --workspace=@packscout/database`, `npm run typecheck --workspace=@packscout/contracts` → exit 0; `npm run test:services` → exit 0 (560 unit/integration + 1 volume, including 22 service tests in `email-links/token-service.test.ts` + format/configuration suites and 6 end-to-end tests in `token-service.integration.test.ts`: concurrency via independent connections, stored-material-cannot-redeem, delivery-failure survival, supersession/expiry, real-bucket rate limiting); `npm run test:database` → exit 0 (153, including 10 repository integration tests: concurrent-consume single success, concurrent-issue single outstanding, transactional compose-with-enqueue rollback/commit, prune-spares-live, audit-sink refusals, limiter window/block/recovery); `npm run test --workspace=@packscout/contracts` → exit 0 (157); `npm run lint:services` and database lint → exit 0; `npm run check:prisma` → exit 0 (schema parity against the regenerated manifest, repeated-deploy idempotence, lifecycle readiness with the new expected migration); `npm run scan:framework-standards:ratchet` → 0 findings, 0 new; `node scripts/check-docs.mjs` → exit 0 (156 files); `npm run check:boundaries` → exit 0 (751 files).
