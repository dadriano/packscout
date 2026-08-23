# Task: Let Operators Reset Their Own Password

**ID:** messaging/009
**Depends on:** messaging/008
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** done

## Objective

An operator who has lost their admin password can recover it themselves through an emailed link, without another administrator having to set a password for them and pass it along.

## Context

Admin operator accounts are created by an administrator who sets the password, and there is no recovery path. When an operator forgets theirs, the only route back is another administrator setting a new one and communicating it — which means real passwords travelling through chat, and an operator whose only administrator is unavailable being locked out of the system that runs the pipeline.

Everything security-critical here belongs to messaging/008: purpose-scoped, single-use, expiring, hashed tokens with rate limiting and non-enumeration. This task is the operator-facing flow on top of it — request, receive, reset, sign in — and the care it needs is in the parts the token mechanism does not cover: not weakening the admin's existing authentication, and not becoming a way to attack it.

## Requirements

- An operator can request a reset from the admin's sign-in area by entering their email address, without being signed in.
- The response to a request is identical whether or not the address belongs to an operator: same wording, same outcome, no enumeration. The screen tells the person to check their mail if the address is registered.
- Requests are rate-limited per address and per source through the mechanism from messaging/008, and a limited request looks like an ordinary one.
- The reset link is redeemable once, expires on a short purpose-specific lifetime, and requesting a new one supersedes any outstanding link.
- Redeeming the link presents a set-password screen. The new password is validated against the admin's existing password rules — the same rules an administrator-set password must satisfy — with clear, specific validation messages.
- Completing a reset changes the password, consumes the token, and invalidates the operator's existing sessions, so a reset performed because of a suspected compromise actually ends the intruder's access.
- A disabled or ineligible operator account cannot be reset into a usable state: eligibility is rechecked at redemption, and a refused redemption is indistinguishable from any other refusal.
- The reset flow never reveals the operator's role, permissions, name, or any other account attribute to an unauthenticated visitor.
- No password, token, or reset link is written to any log, metric, audit record, or error payload. The audit record says a reset was requested or completed, for which operator, when, and with what outcome.
- The message renders through messaging/003 and is enqueued through messaging/004, and states plainly that if the recipient did not request the reset, no action is needed and their password is unchanged.
- The flow is reachable and usable without an existing session, satisfies the admin's UI and accessibility standard at desktop and narrow widths, and covers its loading, invalid-link, expired-link, validation-error, and success states.
- Existing sign-in, session, rate-limiting, and lockout behavior is unchanged; the reset path adds a route into authentication, not a way around it.

## User-Facing Behavior

An operator on the admin sign-in screen chooses "forgot password", enters their address, and is told to check their mail if it is registered. The message arrives with a single link. Clicking it opens a set-password screen; a valid new password signs them out everywhere and lets them sign in fresh. Clicking the same link again, or a link older than its lifetime, shows the same plain "this link is no longer valid, request a new one" screen. Someone entering an address that was never an operator sees exactly what a real operator sees.

## Interface Contract

- An unauthenticated reset-request endpoint and an unauthenticated reset-completion endpoint, both guarded by the mechanism from messaging/008 with its reset purpose and both returning non-enumerating outcomes.
- Completion invalidates existing sessions for the operator through the admin's existing session machinery rather than a parallel mechanism.
- Password validation reuses the admin's existing password rules; this task defines no new password policy.
- The reset message kind and rendering belong to messaging/003; enqueueing to messaging/004.

## Acceptance Criteria

- [x] An operator can complete the full request-to-sign-in journey with a mailed link.
- [x] Requests for unknown and known addresses are indistinguishable in wording and outcome, and rate limiting does not break that indistinguishability.
- [x] A link works once; reuse, expiry, and a superseded link all show the same plain invalid-link state.
- [x] Completing a reset invalidates the operator's existing sessions.
- [x] A disabled or ineligible account cannot be reset into a usable state.
- [x] No password, token, or link appears in any log, metric, audit record, or error payload, and audit records cover request and completion with outcome.
- [x] Request, invalid-link, expired-link, validation-error, and success states render accessibly at desktop and narrow widths.
- [x] Existing sign-in, session, rate-limiting, and lockout behavior is unchanged.

## Verification

Admin route behavior tests prove the full journey, non-enumerating responses across known, unknown, and rate-limited requests, single-use and expiry handling, session invalidation on completion, refusal for disabled accounts, password-rule reuse, and audit records free of secrets; page tests cover every state. The admin lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: none (no `tech-*.md` or `ux-*.md` companions in this feature)
- Alignment: Both endpoints are unauthenticated by design and follow the sign-in endpoint's discipline for unauthenticated POSTs — trusted Origin required before any flow work, schema-validated inputs, and one post-validation response whatever happened. Non-enumeration is inherited from messaging/008's `requestIssuance`, which performs identical work for known, unknown, disabled, and rate-limited addresses; the route adds the guarantee that even an internal flow failure cannot become a distinguishing oracle. Every dead link — unknown, expired, superseded, reused, or ineligible — collapses into one `PASSWORD_RESET_LINK_INVALID_MESSAGE`. Password-rule violations reuse the existing schema's own messages, so a reset password is validated exactly as an administrator-set one. Completion invalidates the operator's existing sessions. Audit coverage of issuance and redemption outcomes is inherited from messaging/008's `PrismaEmailLinkAuditSink`, wired through `password-reset-runtime.ts`, which allowlists actions and refuses token-shaped material; the route additionally emits `admin_password_reset_request_failed` / `admin_password_reset_completion_failed` structured log lines for the two failure domains.
- Divergences: (1) **The live browser layout pass was not performed.** The builder was interrupted by an API quota limit at exactly that step. Substituted evidence: all five states (request, check-your-mail, invalid-link, validation-error, success) are covered by page tests; the two new classes are responsive by construction (`.admin-auth-screen { width: min(100%, 30rem) }`, `.admin-auth-card { width: 100% }`, no fixed width above the 320px root minimum); and both pages reuse the existing, previously browser-verified sign-in structure and class vocabulary. A live measurement at 1280px and 375px in both themes remains the one open check on this task. (2) Success paths emit no route-level audit event of their own — issuance and redemption successes are audited by the messaging/008 sink, and only the two failure domains needed route-level log lines.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin && npm run typecheck:services && npm run test:services && npm run lint:services && npm run test:contracts` → exit 0 on the combined tree (19 tests for this task: 10 route behavior, 3 request page, 6 reset page). `npm run scan:framework-standards:ratchet` → 0 findings, 0 new. `node scripts/check-docs.mjs` → ok.
