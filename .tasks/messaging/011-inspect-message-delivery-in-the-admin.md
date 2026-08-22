# Task: Inspect Message Delivery in the Admin

**ID:** messaging/011
**Depends on:** messaging/004, admin-tools/001
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** todo

## Objective

Operators can answer "did that message actually go out?" from the admin — a searchable history of what was sent, to whom, when, through which provider, and what happened to it.

## Context

The moment PackScout starts sending mail, someone will ask whether a specific message arrived: an approved beta user says they never got the email, an operator did not receive an alert about an outage, an invited colleague never got their link. Without a delivery record the only answers are guesses and provider dashboard archaeology.

The queue from messaging/004 already records intents and attempts with outcomes, providers, error codes, and provider message identifiers. This task surfaces that, and adds the one operational affordance the queue cannot decide for itself: retrying something that failed terminally, once a human has fixed the underlying cause.

The care needed here is about restraint. A delivery log is a list of who was sent what — recipient addresses are personal data, and message bodies would be worse. The log shows enough to diagnose and no more.

## Requirements

- A Messages destination in the admin navigation, visible only to operators holding a named permission for viewing message delivery, and guarded server-side by it. The permission is granted to the administrator role only, following the existing permission vocabulary conventions.
- The history lists delivery intents with: the message kind, a bounded display of the recipient, current state, attempt count, when it was created and last attempted, the provider used, and the stable error code for failures.
- Ordering is by recency with bounded pagination; filtering covers at least state and message kind; search covers the recipient.
- An intent's detail shows its attempt history — each attempt's time, provider, outcome, stable error code, and the provider's message identifier on success — so a delivery can be correlated with the provider's own records.
- Message bodies are never displayed or stored for display. The log shows what kind of message it was, not what it said.
- Recipient addresses are shown because diagnosis requires them, but never travel in URLs, query strings, or browser history, and never appear in admin logs or metrics beyond audit-relevant identifiers.
- Counts of pending, retrying, and terminally failed intents are visible at a glance so a stuck queue is noticed rather than discovered.
- An operator holding a named permission for managing message delivery can retry a terminally failed intent. The retry is explicit, confirmed, bounded, and audited; it re-enters the normal queue rather than sending inline.
- Retrying an intent that is not terminally failed is refused, and concurrent retries of the same intent converge on one.
- Data operators receive the standard forbidden outcome for every route here and see no Messages navigation; anonymous requests receive the standard unauthenticated outcome.
- If the delivery records are unavailable, the area degrades to a clear, non-destructive error state; no credential or raw backend error reaches the browser.
- The area reuses the admin's existing template, ledger, filter, confirmation, toast, and empty-state patterns, and covers loading, empty, no-match, error, and forbidden states accessibly at desktop and narrow widths.

## User-Facing Behavior

An operator opens Messages, filters to failures, and sees that six approval emails failed with the same provider error code an hour ago. Opening one shows three attempts with backoff and the error each time. After the cause is fixed, they retry the failed ones and watch them move to sent. A glance at the header tells them whether anything is currently stuck.

## Interface Contract

- Protected admin endpoints for listing intents with filtering, search, and bounded pagination; reading one intent's attempt history; reading queue-state counts; and retrying a terminally failed intent — the first three guarded by the view permission and the retry by the manage permission.
- All of them read the intent and attempt records committed by messaging/004; this task adds no new delivery state of its own.
- Retry re-enqueues through messaging/004's normal path with its existing idempotency and claiming rules.
- Two named permissions are added to the existing vocabulary, granted to the administrator role only.

## Acceptance Criteria

- [ ] Administrators can list, filter, search, and page delivery intents and open an intent's attempt history with provider, outcome, error code, and provider message identifier.
- [ ] No message body is displayed anywhere, and recipient addresses never appear in URLs, query strings, or browser history.
- [ ] Pending, retrying, and terminally failed counts are visible without paging the list.
- [ ] A terminally failed intent can be retried with confirmation; the retry is audited, bounded, and re-enters the queue rather than sending inline.
- [ ] Retrying a non-terminal intent is refused, and concurrent retries converge on one.
- [ ] Anonymous and data-operator requests receive the standard unauthenticated and forbidden outcomes, and data operators see no Messages navigation.
- [ ] Loading, empty, no-match, error, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.

## Verification

Admin route behavior tests prove the permission matrix for both permissions, listing with filtering, search and pagination bounds, attempt-history contents, count accuracy, retry outcomes including refusal for non-terminal intents and convergence under concurrency, audit emission, and sanitized failure mapping; page tests cover every state and assert no message body is rendered. The admin lint, typecheck, test, and build commands exit 0.
