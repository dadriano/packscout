# Task: Route Operational Alerts to Operators by Email

**ID:** messaging/005
**Depends on:** messaging/003, messaging/004
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** in_progress

## Objective

Operational alerts reach the people who can act on them: a run failure, a stale provider, or a dead worker produces email to the configured operators, throttled and severity-scoped so the signal survives.

## Context

PackScout's pipeline already detects the problems worth knowing about and publishes them through an abstract notification boundary, where they are persisted for the admin's alerts area. Nothing leaves the building — an operator learns that the pipeline died by opening the admin and looking. External delivery was deliberately deferred with the note that the abstract boundary stands, waiting for a delivery layer. This is that delivery.

The boundary is already a composite of publishers, so email arrives as one more publisher rather than as a change to any producer. That matters: every existing alert source keeps working unchanged, and email can be switched off without touching pipeline code.

The failure mode to design against is not missing an alert — it is drowning in them. A provider that flaps every ninety seconds must not produce a hundred emails, and a critical incident must not be buried under informational noise. The alert layer already deduplicates and tracks occurrence counts and recovery, so the routing decision has real state to work with rather than a raw event stream.

## Requirements

- Email delivery attaches as an additional publisher on the existing notification boundary. No alert producer changes, and the durable admin persistence keeps working exactly as it does now.
- A publisher failure never breaks alert persistence or the producing operation: if email cannot be enqueued, the alert is still recorded and the pipeline work still completes.
- Severity routing is configurable: which severities produce email is a server-side setting with a sensible default that sends critical and warning alerts and leaves informational ones to the admin.
- Recipients are administrator-configurable rather than hard-coded, resolved at send time so a departed operator stops receiving mail. When no recipient is configured, alerts are persisted as they are today and the absence is visible to operators rather than silent.
- Flood control is explicit: repeat occurrences of an already-notified alert do not produce a new message within a configured window, and a summarized count is used instead of one message per occurrence. The existing deduplication and occurrence tracking is the input to this decision, not a parallel mechanism.
- Recovery is communicated: when an alert resolves, the operators who were told about it learn that it recovered, so nobody chases a fixed problem.
- Each message states what happened, which provider or run it concerns, how many times it has occurred, when it started, and where to look in the admin — using only the alert's already-safe title, summary, and evidence codes. No credential, no raw provider error, no payload content.
- Messages are enqueued through messaging/004, never delivered inline, so an alert storm cannot slow or block pipeline work and a provider outage does not lose alerts.
- Enqueue volume per alert is bounded, so a pathological alert source cannot fill the queue.
- Email routing is independently switchable off, leaving all existing alert behavior intact.

## User-Facing Behavior

An operator gets an email when something breaks that they can do something about: what failed, how long it has been failing, how many times, and a link into the admin's alert detail. A flapping provider produces one message and then a periodic summary, not a stream. When it recovers, they get a short recovery note. Informational events stay in the admin where they belong.

## Interface Contract

- An email notification publisher implementing the existing notification publisher interface, composed alongside the durable admin publisher; its result never changes the composite's overall outcome for producers.
- It renders through the operational-alert message kind in messaging/003 and enqueues through messaging/004, using an idempotency key derived from the alert's deduplication identity and notification window so repeat occurrences converge.
- Severity thresholds, recipients, and the flood-control window are server-side configuration.
- Recovery notices are keyed to the alert's existing recovery identity so they reach exactly the recipients who were notified.

## Acceptance Criteria

- [ ] Alerts at the configured severities produce enqueued messages; alerts below them do not, and all alerts persist to the admin exactly as before.
- [ ] A failure to enqueue leaves alert persistence and the producing pipeline operation unaffected.
- [ ] Repeat occurrences within the flood-control window produce no new message, and a summarized occurrence count is delivered instead of per-occurrence messages.
- [ ] Recovery of a notified alert delivers a recovery notice to the operators who were notified.
- [ ] With no recipient configured, alerts persist as today and the missing configuration is visible to operators rather than silent.
- [ ] Message content carries only the alert's safe title, summary, and evidence codes — no credential, raw provider error, or payload content.
- [ ] Turning email routing off restores exactly the current behavior.

## Verification

Tests prove severity filtering, unchanged persistence when email publishing fails, flood-control suppression and summarized counts across repeat occurrences, recovery notice delivery to the notified recipient set, the unconfigured-recipient path, safe message content, and the off switch. Enqueue is asserted rather than delivery, with messaging/004 covering delivery itself. The workspace typecheck and the services test command exit 0.
