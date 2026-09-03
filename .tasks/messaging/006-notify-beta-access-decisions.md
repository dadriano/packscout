# Task: Notify Product Users of Beta Access Decisions

**ID:** messaging/006
**Depends on:** messaging/003, messaging/004, closed-beta-access/003, closed-beta-access/010
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** done

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

- [x] Approving a waiting user enqueues an approval message; declining enqueues a decline message; revoking and allowlist admission enqueue nothing.
- [x] An identity with no verified address is skipped as a normal, recorded outcome, and the administrator's decision still succeeds.
- [x] A decision succeeds and takes effect even when enqueueing fails, and the enqueue failure is visible to operators.
- [x] Repeat or concurrent decisions produce no duplicate messages; genuine re-transitions produce one message each.
- [x] Message content carries no credential, sign-in token, operator note, or internal reasoning.
- [x] Recipient addresses appear only where delivery requires them, never in admin logs, metrics, or URLs.

## Verification

Admin behavior tests prove enqueueing on approve and decline, silence on revoke and allowlist admission, the skipped outcome for identities with no verified address, decision success despite enqueue failure, and idempotent behavior across repeat and concurrent decisions; rendering assertions confirm the absence of credentials and operator notes. The workspace typecheck, the services test command, and the admin test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md` (this task supersedes the closed-beta exclusion; 012 reconciles the indexes); messaging/003's Spec Compliance (`renderAccessApprovedMessage`/`renderAccessDeclinedMessage`, both `{toEmail}`; approved links to the product via the configured origin, declined deliberately link-free; content rules enforced by the catalogue's pinned snapshots); messaging/004 (`EmailMessageOutboxService.enqueueEmailMessage` — explicit results, idempotent convergence, per-source volume bound; the outbox stores kind + rendering input and the drain renders); closed-beta-access/003 (decision outcomes: `decided` with `previous`/`resulting`/`changed`, `nothing_to_decide`; genuine flips stamp their own `decidedAt`, converged repeats keep the stored one); closed-beta-access/010 (the admin decision route extended here, its two-failure-domain audit pattern, and the `/admin/product-users/record` single-record integration read); messaging/007 (the welcome dispatcher precedent for the recipient bound and subject hashing); `docs/admin-feature-baseline.md`.
- Alignment: `apps/admin/server/access-decision-notice.ts` is the notice service. After a decision commits, the route (`server/routes/product-users.ts`) calls `notifyAccessDecision({subject, changed, resulting})`, which resolves to a closed result and never rejects. A genuine approve or decline transition (`changed: true`, resulting state `approved`/`declined` — the kind follows the state the backend now holds, so the message can never disagree with the record) reads the verified address back through the new single-record reader method (`getProductUserRecord` in `server/product-user-directory.ts`, posting to the existing `/admin/product-users/record` endpoint, references dropped at the boundary as everywhere else) and enqueues `access_approved`/`access_declined` with input `{toEmail}`, recipient, source `beta_access_decision`, and idempotency key `accessdecision:{sha256hex(subject)}:{approved|declined}:{epoch-ms of resulting.decidedAt}` — repeats and concurrent arrivals of one transition converge in the outbox, a re-transition (approve → revoke → approve) carries a fresh `decidedAt` and earns a fresh message, and neither the raw subject nor any address can appear in the key. A revoke (resulting `awaiting_review`) and a converged repeat (`changed: false`) attempt nothing — not even the record read — and allowlist admissions never traverse this path at all (admitted at sign-in in the product backend; their greeting is messaging/007's welcome). No verified or usable address is the recorded skip: the decision succeeds, nothing is enqueued, and the decision's own success audit event carries `notice: skipped_no_verified_email` (`server/product-user-audit.ts` gained the closed `notice`/`noticeReason` metadata vocabulary). Every notice failure — record read, outbox refusal or backlog, thrown enqueue — is a stable non-personal code recorded the same way (`notice: failed` + `noticeReason`) and reported through the new `onNoticeFailure` hook (defaulting to one bounded log line, mirroring `onAuditFailure`), while the response still reports the committed decision: the browser payload is unchanged (`{action, changed, access, effectiveAccess}`) and never mentions the notice or any address. Wiring appends only: `access-decision-notice-runtime.ts` constructs `EmailMessageOutboxService` over `PrismaEmailMessageOutboxRepository` (the same repository the worker drains and messaging/011 reads), and `server/index.ts` appends the `decisionNotice` dependency to the product-users block over the same directory integration.
- Divergences: (1) The recorded skip and the visible enqueue failure live on the decision's audit event rather than a new browser response field — the response contract stays exactly 010's, the users page needs no change, and the audit trail is the durable operator-visible record; the failure is additionally surfaced through the `onNoticeFailure` report. (2) A present-but-unusable address (one the outbox recipient bound would refuse) is the same permanent recorded skip as no address, not a retryable failure — retrying a validation that will never change its mind is the welcome dispatcher's precedent. (3) A process crash in the window between the committed decision and the enqueue loses that transition's message — the same accepted window the audit write has always had on this route; a later revoke + re-approve is a fresh transition and messages normally. (4) The message-content criteria (no credential or sign-in token, no operator notes, approved links to the product, declined brief and link-free) are owned and already pinned by messaging/003's catalogue snapshots; this task supplies only `{toEmail}` and asserts kind + input.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin` → chained exit 0 (admin: 283 tests passed; 19 new: 10 unit in `server/access-decision-notice.test.ts` — approve/decline enqueue with exact key, revoke silence, changed-false silence, key convergence + fresh re-transition keys, no-address and unusable-address skips, bounded failure codes for record read and outbox refusal/throw with no leaked address or subject, deduplicated passthrough, unreadable-instant fail-closed; 7 behavior in `server/routes/product-users.behavior.test.ts` — approval enqueues after commit with the exact key and untouched browser payload, decline enqueues, revoke/unknown-subject/standing silence with the allowlist statement, repeat convergence with no second read or message, re-transition fresh keys on advancing decision instants, no-verified-address recorded skip with the decision still succeeding, and committed decisions surviving thrown/rejected enqueues and unreadable records with audited + reported non-personal failure codes; 2 in `server/product-user-directory.test.ts` — the record read as a single POST with the subject in the body and references dropped, and not-found/broken/unconfigured outcomes). `npm run typecheck` (workspace) → exit 0. `npm run test:services` → 584 passed, 0 failed (services untouched by this task; the shared worktree includes the parallel operator-account work). `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new, 0 grown modules. `node scripts/check-docs.mjs` → ok, 158 markdown files.
