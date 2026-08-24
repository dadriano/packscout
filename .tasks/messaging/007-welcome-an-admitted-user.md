# Task: Welcome an Admitted User on First Sign-In

**ID:** messaging/007
**Depends on:** messaging/003, messaging/004, closed-beta-access/001
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** done

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

- [x] A welcome is enqueued at the first admitted session and never before admission.
- [x] Exactly one welcome is ever enqueued per identity, including under concurrent discovery, and re-admission after revocation sends none.
- [x] Identities already active before this ships are not welcomed retroactively.
- [x] An identity with no verified address is recorded as not applicable and never retried.
- [x] A crash between claiming and enqueueing results in a later retry, not a silent skip or a duplicate.
- [x] Sign-in behavior, latency, access, and capabilities are unchanged regardless of welcome outcome.
- [x] The message carries no credential, tokenized link, or promotional content.
- [x] Welcome sending can be switched off without affecting other message kinds.

## Verification

Tests prove the first-admitted-session trigger, single-send under concurrent discovery, no re-send after revocation and re-admission, no retroactive welcome for pre-existing identities, the no-address skip, crash-between-claim-and-enqueue recovery, bounded discovery passes, and that sign-in is unaffected by every welcome outcome. The workspace typecheck, the services test command, and the product-backend test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md`; messaging/003 (the `welcome` catalogue kind and `renderWelcomeMessage`, consumed unchanged); messaging/004 (the durable outbox this task enqueues through — `EmailMessageOutboxService.enqueueEmailMessage`, whose idempotency key converges duplicate enqueues on one intent); closed-beta-access/001 (effective access and the establishment write path the marker arms in) and 003 (the operator-integration HTTP surface pattern and the decision operations the marker must survive); `convex/_generated/ai/guidelines.md`.
- Alignment: the durable marker lives on the `productUsers` directory record as an optional `welcome` field (`productUserWelcomeMarkerValidator` in `convex/productUserRecords.ts`): absent means not yet due, then `due` → `claimed` (with `claimExpiresAt`) → `sent`, or terminal `not_applicable` with reason `no_verified_email` or `grandfathered`. Arming happens only inside `establishProductUserRecord` (`convex/productUsers.ts`) — the path both `recordSignIn` and `establishAccess` already share — as one extra conditional patch field in the same transaction: no new client-visible behavior, no return-shape change, no extra roundtrip, and query paths untouched. The arming rule (`welcomeMarkerAtEstablishment`) triggers on the first session whose composed decision-plus-standing answer is admitted, never on a decision alone; decisions (operator approve/decline/revoke, allowlist admission, standing flips) never write the marker, so it persists through revocation and re-admission — that persistence plus terminal `sent` is the once-ever half, and the outbox idempotency key `welcome:{sha256(subject)}` (`welcomeIdempotencyKey`, source `closed_beta_welcome`) is the convergence half. Discovery and settlement are `internalMutation`s in `convex/productUserWelcome.ts` over a new `by_welcome_state_and_welcome_claim_expires_at` index: `claimDueWelcomes` atomically claims a bounded batch (≤20, oldest first, lapsed claims reclaimed by expiry range-scan) and `settleWelcome` settles `sent` (meaning durably enqueued) or `no_verified_email`, both idempotent and convergent. They are reachable only through two new POST routes on the existing admin-integration surface in `convex/http.ts` (`/admin/product-users/welcome/claim`, `/welcome/settle`), same bearer secret, same non-leaking fixed-string refusals, subjects and addresses only in JSON bodies — no new inbound surface into the delivery layer. The dispatcher is `WelcomeDispatchService` (`packages/services/src/welcome-dispatch/`) with a bearer directory client and per-cycle env settings (`resolveWelcomeDispatchSettings`), run as a worker job beside the outbox drain (`apps/worker/src/provider-worker-welcome-dispatch.ts`, composed in `provider-worker-composition.ts`, cadence and bounds in `runtime-config.ts`), reporting cycle facts and failures through the runtime's logger like its siblings. A crash between claim and enqueue lapses the claim back to due; re-enqueue converges on one intent; settlement happens only after the durable enqueue. An identity with no verified address is settled `not_applicable` at arming time (and defensively at dispatch), recorded once, never retried. `PACKSCOUT_WELCOME_EMAIL_ENABLED` switches the welcome kind off independently: the dispatcher idles and no other kind or job consults it.
- The grandfathering rule, as implemented (documented verbatim on `welcomeMarkerAtEstablishment`): a markerless record is armed only at an establishment contact where the composed answer is admitted, and only when (1) this establishment itself moved the identity to approved (allowlist match, including at first-ever contact), or (2) the stored approval's `decidedAt` is strictly after the record's previous `lastSeenAt` — the decision landed between contacts, so no session has happened while admitted and this one is the first. Otherwise — approved with `decidedAt` at or before the previous `lastSeenAt`, i.e. at least one contact already happened while approved — the identity's first admitted session predates this machinery and the marker is set to `not_applicable`/`grandfathered`, decided once and never revisited. No rollout timestamp constant exists; the record's own decision-versus-contact ordering is the guard, so identities already using the product are never welcomed retroactively regardless of when this deploys, while a pre-existing approval whose holder never returned after it is armed on their next contact (they are newly reaching their first admitted session).
- Divergences and deliberate consequences: (1) Arming keys on the composed decision-plus-standing answer independent of `PACKSCOUT_CLOSED_BETA`, mirroring closed-beta-access/003's switch-independent decisions — with the switch off nobody is armed by the everyone-is-admitted short-circuit, only real approvals arm. (2) An identity whose only post-approval contacts happened while suspended reads as grandfathered after reinstatement (contact recency is the only durable trace of sessions; standing history is not stored) — it errs toward silence, pinned by a test. (3) A `due` marker records a durable fact, so the dispatcher does not re-check effective access at claim time; a revocation racing the dispatcher does not unmake the first admitted session, and re-admission still yields at most one welcome. (4) `sent` means durably enqueued with the delivery layer; delivery attempts and outcomes are messaging/004's records, surfaced by messaging/011. (5) A syntactically unusable stored address settles as the no-address skip rather than retrying forever against validation that cannot change its mind. (6) The dispatcher's worker activity reports under the existing `message_outbox` activity kind (it feeds that queue) rather than adding a fleet-vocabulary member; its own log events (`provider_welcome_dispatch_cycle_finished`/`_failed`) keep it distinguishable. (7) The integration reuses the admin surface's variables (`PACKSCOUT_ADMIN_DIRECTORY_URL`/`_TOKEN`) so one origin and one secret configure the surface for both consumers; unusable configuration idles the job instead of failing the worker.
- Verification: `npm run typecheck:convex && npm run test:convex && npm run typecheck:services && npm run test:services && npm run lint:services && npm run test:worker` → exit 0 (convex 29 files / 274 tests, 23 of them in `convex/productUserWelcome.test.ts` — first-admitted-session trigger via allowlist and via operator approval, decision-alone arms nothing, single-claim under concurrent discovery, no re-send after revocation and re-admission, grandfathered pre-existing identities including the `decidedAt == lastSeenAt` tie, the armed-because-never-returned case, the no-address skip never revisited, claim lapse and reclaim after a crash between claim and enqueue, bounded oldest-first claims, terminal idempotent settlement, unchanged establishment contracts, and the authenticated HTTP surface; services 578 unit + 1 volume tests, 18 under `src/welcome-dispatch/` — settle-only-after-durable-enqueue, dedupe convergence on the identical key, refused-enqueue leaves the claim to lapse, contained settlement failure, poisoned-identity fairness, bounded passes, key alphabet/determinism, switch and integration settings; worker 105 tests including cadence gating, off-switch and unconfigured idling, runtime logging and failure containment, and config bounds). `npm run scan:framework-standards:ratchet` → exit 0 (0 findings, 0 new, 0 grown). `node scripts/check-docs.mjs` → ok, 156 markdown files. `npm run typecheck:frontend` → exit 0 (generated api consumers unaffected). `npm run typecheck:worker`, `lint:worker`, `typecheck:contracts`, `lint:contracts` → exit 0.
