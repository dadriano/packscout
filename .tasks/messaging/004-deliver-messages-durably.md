# Task: Deliver Messages Durably With Retries

**ID:** messaging/004
**Depends on:** messaging/001
**Blocks:** messaging/005, messaging/006, messaging/007, messaging/008, messaging/011
**Estimated scope:** large
**Status:** todo

## Objective

Sending a message is a durable, at-least-once operation: the request survives a crash, a provider outage is retried with backoff rather than dropped, the same event never sends twice, and every attempt leaves a record.

## Context

Calling a provider inline from whatever code noticed something happened is the version of this that fails quietly. The provider goes down for ninety seconds and the approval emails from that window are gone; the process restarts mid-send and nobody knows whether the message went; a retry loop somewhere sends the same welcome four times.

So messages are enqueued, not sent. A sender records the intent durably and returns; a background drain claims due messages, renders and delivers them through the boundary from messaging/001, and records the outcome. Retryable failures come back with backoff until a bounded attempt limit, then rest as terminally failed and visible. PackScout already runs a background worker with schedule claiming for its pipeline, and this drain belongs alongside it rather than as a second scheduling mechanism.

At-least-once plus an idempotency key is the honest guarantee. Exactly-once delivery is not available across a network boundary to a third party, so the design makes duplicates impossible for the same triggering event, and accepts that a message whose provider call succeeded while the acknowledgement was lost may be sent twice in the worst case — a known, bounded exposure rather than a pretence.

## Requirements

- Enqueueing is durable and transactional with respect to the caller's own work where the caller has any: a message intent that was recorded survives a crash, and one that was not recorded is not half-sent.
- Each intent carries the message kind, its typed rendering input, the resolved recipient, an idempotency key derived from the triggering event, the time it becomes due, and its attempt state.
- The idempotency key makes duplicate enqueues for the same triggering event converge on one intent, whether they arrive concurrently or minutes apart.
- A background drain claims due intents so that two workers never deliver the same intent concurrently, using the same claiming discipline the platform's existing background work already uses.
- Each attempt renders through messaging/003 and delivers through the messaging/001 boundary. A rendering failure is terminal — it will not improve on retry — and is recorded as such rather than retried.
- Retryable delivery failures are retried with bounded exponential backoff up to a configured attempt limit, after which the intent rests in a terminal failed state. Terminal failures are never retried.
- A skipped outcome — delivery disabled, console mode, or missing configuration — is recorded as skipped and is not a failure, so a local or intentionally disabled environment produces clean records rather than a growing failure pile.
- Every attempt records what happened: when, which provider, the outcome, the stable error code on failure, the provider's message identifier on success, and the attempt number. Recipient addresses are stored because delivery needs them, but no message body, credential, or raw provider error is retained beyond the sanitized code and text.
- The queue is bounded and observable: how many intents are pending, due, retrying, and terminally failed is answerable without scanning the whole table, and enqueue volume per triggering source is bounded so a misbehaving caller cannot fill the queue unboundedly.
- Draining is fair: one poisoned or slow intent cannot starve the rest, and one recipient's backlog cannot monopolize a drain cycle.
- Retention: attempt records are pruned on a schedule consistent with the platform's existing retention policy, and pruning never deletes an intent that is still pending or retrying.
- The drain never blocks the work that enqueued the message. A caller's operation succeeds or fails on its own merits regardless of what happens to the message afterwards.
- When the delivery layer is unreachable or unconfigured, enqueueing still succeeds and the intents wait; nothing is dropped because delivery happens to be down at the moment of the trigger.

## User-Facing Behavior

Invisible when it works. Its effect is that a message triggered during a provider outage still arrives once the provider recovers, and that a person never receives the same notice twice because of a retry.

## Interface Contract

- An enqueue operation taking the message kind, its typed rendering input, the recipient, and an idempotency key, returning the intent's identity. It performs no network work.
- An intent's lifecycle states: pending, retrying, sent, skipped, failed — the vocabulary messaging/011 displays.
- The drain is a background job registered with the platform's existing background work, reporting the same liveness and progress facts the platform's other background work reports.
- Consumers — messaging/005, messaging/006, messaging/007, messaging/008 — enqueue and never call a provider or the delivery boundary directly.
- Attempt history keyed by intent is readable for messaging/011.

## Acceptance Criteria

- [ ] An enqueued intent survives process restart and is delivered afterwards.
- [ ] Duplicate enqueues for the same triggering event converge on one intent, including under concurrent arrival, and the recipient receives one message.
- [ ] Two concurrent drains never deliver the same intent twice.
- [ ] Retryable failures retry with bounded backoff to the attempt limit, then rest as terminally failed; terminal failures and rendering failures are never retried.
- [ ] Skipped outcomes are recorded as skipped rather than as failures in disabled or console environments.
- [ ] Attempt records carry outcome, provider, stable error code, provider message identifier, and attempt number, and retain no message body, credential, or raw provider error.
- [ ] Pending, due, retrying, and terminally failed counts are answerable without a full scan, and per-source enqueue volume is bounded.
- [ ] A slow or poisoned intent does not starve the rest of the queue.
- [ ] Enqueueing succeeds and intents wait when delivery is unconfigured or unreachable; nothing is dropped.
- [ ] A caller's own operation is unaffected by any delivery outcome.

## Verification

Tests prove durability across a simulated restart, idempotent convergence under concurrent enqueue, exclusive claiming under concurrent drains, backoff and attempt-limit behavior, terminal versus retryable classification including rendering failures, skipped recording in disabled and console modes, attempt-record contents and the absence of retained bodies and secrets, bounded counting, fairness under a poisoned intent, and enqueue success while delivery is unconfigured. The workspace typecheck, the services test command, and the worker test command exit 0.
