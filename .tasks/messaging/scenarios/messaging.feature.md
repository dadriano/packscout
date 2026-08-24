# Feature: Transactional messaging

Status: built — provider delivery unproven against a live provider account
Owner: platform build

Every scenario below states its coverage. A scenario marked Automated names checks that exist in this repository; a scenario marked Manual gap says what is missing and why. Nothing here implies coverage it does not have.

## Scenario: An operational alert reaches operators once, not once per occurrence

Given alert email is enabled with configured recipients and the default severity set
When a warning or critical alert is published through the operational notification boundary
Then exactly one message is enqueued per recipient for that alert
And repeat occurrences inside the flood-control window enqueue nothing further
And the first notification past the window carries the accumulated occurrence count
And an informational alert is persisted for the admin without producing any message

Coverage: Automated — `packages/services/src/alert-email/publisher.test.ts` ("configured severities enqueue one message per recipient; info stays admin-only", "repeat occurrences inside the window converge on one idempotency key", "the first occurrence past the window summarizes the accumulated count") and `packages/services/src/alert-email/alert-email.integration.test.ts` against real durable alert state.

## Scenario: Alert delivery never becomes a pipeline failure

Given alert email is enabled
When the delivery queue is unreachable, throws, or refuses the enqueue for backlog
Then the alert is still persisted for the admin exactly as before
And the producing pipeline operation completes unchanged
And an alert that resolves delivers a recovery notice to the operators who were notified

Coverage: Automated — `packages/services/src/alert-email/publisher.test.ts` ("email trouble never changes the composite outcome for producers", "recovery notices reach recipients for alerts this event resolved at notified severities", "the off switch restores exactly the durable-only behavior").

## Scenario: A waiting beta user learns the administrator's decision

Given a product user is awaiting review and has a verified email address
When an administrator approves them
Then an approval message is enqueued after the decision has committed
And declining instead enqueues the decline message
And revoking an approved user announces nothing
And a repeat or concurrent decision that changes nothing enqueues nothing
And a genuine re-transition earns a fresh message with a fresh key

Coverage: Automated — `apps/admin/server/access-decision-notice.test.ts` and `apps/admin/server/routes/product-users.behavior.test.ts` ("a genuine approval enqueues the approval message after the decision commits", "a genuine decline enqueues the decline message", "revoke and allowlist admission announce nothing", "a repeat decision converges without a second message", "a genuine re-transition earns a fresh message with a fresh key").

## Scenario: A decision stands even when its message cannot be sent

Given an administrator decides a waiting user's access
When the recipient has no verified address, or the queue refuses the enqueue
Then the decision still commits and is reported as committed
And the outcome is recorded on the decision's audit event rather than lost
And no recipient address appears in the browser payload or in admin logs

Coverage: Automated — `apps/admin/server/routes/product-users.behavior.test.ts` ("an identity with no verified address is skipped as a recorded outcome", "a committed decision survives a failed enqueue, and the failure is named").

## Scenario: A newly admitted user is welcomed exactly once, ever

Given an identity reaches its first session in which it is admitted
When the welcome dispatcher runs
Then exactly one welcome message is enqueued for that identity
And concurrent dispatchers never hand the same identity to two passes
And an identity already using the product before this shipped is never welcomed
And an identity admitted, revoked, and admitted again is never welcomed a second time
And an identity with no verified address is recorded as not applicable and never retried

Coverage: Automated — `convex/productUserWelcome.test.ts` ("concurrent discovery never hands the same identity to two dispatchers", "sent is terminal: settlement is idempotent and the identity is never discovered again", "an approved identity that already had a contact while approved is grandfathered, not welcomed", "admitted, revoked, and admitted again is never welcomed a second time") and `packages/services/src/welcome-dispatch/dispatch-service.test.ts` ("a crash between claim and enqueue converges on one message: the retry pass deduplicates and settles").

## Scenario: An operator recovers their own password and is signed out everywhere

Given an operator cannot sign in and requests a reset for their address
When they open the mailed link and set a new password
Then they can sign in with the new password
And every session they had before the reset is invalidated
And requests for unknown, disabled, and rate-limited addresses are indistinguishable from a known one
And reuse, expiry, and supersession of the link all show the one invalid-link state
And the reset path never touches the sign-in lockout counters

Coverage: Automated — `apps/admin/server/routes/password-reset.behavior.test.ts` ("an operator completes the full request-to-fresh-sign-in journey, and completion signs them out everywhere", "known, unknown, disabled, and rate-limited requests are indistinguishable at the endpoint", "reuse, expiry, and supersession collapse into the one invalid-link state", "the reset path and the sign-in lockout never touch each other's counters"). Manual gap — the mailed link has not been followed from a real inbox; the link is verified from the enqueued intent, not from a delivered message.

## Scenario: An invited operator activates and signs in

Given an administrator creates an operator with an address and a role and no password
When the invited person opens the mailed link and sets their own password
Then the account becomes active and they can sign in
And the account could not authenticate by any route while it was pending
And reissuing supersedes the outstanding link, and cancelling invalidates it
And a reused, superseded, expired, or cancelled link returns one identical invalid response

Coverage: Automated — `apps/admin/server/routes/operator-invitations.behavior.test.ts` ("an invited operator activates through the mailed link and the message names who invited them", "a link works once: reuse, supersession, expiry, and cancellation share one outcome") and `packages/services/src/auth-service.test.ts` ("a pending account is refused by every authentication path"). Manual gap — as above, the link is verified from the enqueued intent rather than from a delivered message.

## Scenario: A failed message is retried from the admin and succeeds

Given a message has exhausted its attempts and rests terminally failed
When an administrator retries it from the Messages area
Then it re-enters the normal queue and the worker delivers it on the next pass
And retrying a message that is not terminally failed is refused
And two administrators retrying at once converge on one requeue
And the retry is audited without any recipient address or message content

Coverage: Automated — `apps/admin/server/routes/messages.behavior.test.ts` ("retrying enforces the manage matrix with CSRF and re-enters the queue", "retrying a non-terminal or vanished intent is refused, recorded, and changes nothing") and `packages/database/src/email-message-outbox-repository.integration.test.ts` ("requeueing refuses every non-terminal-failed state and concurrent requeues converge on one").

## Scenario: A provider outage delays messages rather than losing them

Given messages are enqueued while the provider is unreachable
When the provider returns
Then the waiting messages are delivered
And retryable failures backed off exponentially to the attempt limit before resting failed
And a rendering failure rested terminally without consuming retries
And an enqueued message survived a process restart

Coverage: Automated — `packages/database/src/email-message-outbox-repository.integration.test.ts` ("an enqueued intent survives its writer's shutdown and is claimable afterwards", "retryable failures back off to the limit then rest failed; non-retryable failures rest at once") and `packages/services/src/message-outbox/drain-service.test.ts` ("a rendering failure is terminal: recorded non-retryable and never sent", "the backoff schedule doubles from the base and never exceeds the cap").

## Scenario: Disabled and console modes send nothing and record cleanly

Given delivery mode is disabled, or console, or a named adapter with no configuration
When the drain processes due messages
Then nothing is sent
And each intent is recorded as skipped with its reason rather than as a failure
And console mode renders the message locally so a developer can read exactly what would have been sent

Coverage: Automated — `packages/services/src/email-delivery/delivery-service.test.ts` ("disabled mode sends nothing and reports skipped", "console mode renders the message locally, skips sending, and never renders in production-like environments") and `packages/database/src/email-message-outbox-repository.integration.test.ts` ("skipped outcomes rest as skipped with their reason").

## Scenario: The provider is swappable without touching a caller

Given the delivery boundary with its registered adapters
When the delivery mode is switched between console and the provider adapter
Then behavior changes with no change to any calling code
And the adapter contract suite passes for every registered adapter
And an adapter that violates any contract behavior fails the suite

Coverage: Automated — `packages/services/src/email-delivery/adapter-contract-suite.test.ts` (12-check matrix against a conforming stub, plus six rejection cases proving a violating adapter fails), `packages/services/src/email-delivery/postmark-adapter.test.ts` (the same suite against the real adapter), `packages/services/src/email-delivery/delivery-service.test.ts` ("a named mode delivers through that adapter without changing the caller").

## Scenario: No message carries a secret

Given any message kind in the catalogue
When it is rendered
Then no credential, token value, session identifier, or raw provider error appears in it
And interpolated values cannot inject markup
And a one-time link passes through opaque and uninspected
And no token material reaches any log line, audit record, or thrown error

Coverage: Automated — `packages/services/src/message-catalogue/catalogue.test.ts` ("credential-shaped interpolated content fails rendering", "interpolated values cannot inject markup", "a one-time link path passes through opaque and uninspected") and `packages/services/src/email-links/token-service.test.ts` ("no token material reaches the console, the audit trail, or a thrown error").

## Standing manual gaps

1. **No message has been delivered by the real provider.** Every scenario above verifies behavior up to and including the enqueued intent and the adapter's treatment of stubbed provider responses; none has been proven against a live provider account with a real sending domain. Closing this needs a configured account and a verified sender.
2. **Mailed links have not been followed from a real inbox.** Reset and invitation links are verified from the enqueued intent. The link construction, its absolute origin, and its redemption are covered; the round trip through an inbox is not.
3. **Bounce and spam-complaint handling does not exist and is deliberately out of scope.** See the deferred-deliverability note in `docs/messaging-operations.md`.
