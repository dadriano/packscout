# Task: Add the Postmark Delivery Adapter

**ID:** messaging/002
**Depends on:** messaging/001
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** todo

## Objective

PackScout can actually deliver email through Postmark — as one adapter behind the delivery boundary, configured entirely by server-side settings, with no caller anywhere naming it.

## Context

Postmark is the provider PackScout is starting with. The approved reference platform's adapter for it is the working template: it posts a rendered message to the provider's email endpoint with the server token in a request header, reads back the provider's message identifier on success, and turns provider error codes into classified failures.

The adapter is deliberately thin. It knows how to talk to one provider and nothing else — no queueing, no retries, no templates, no knowledge of what any message means. Everything it needs to be trusted is defined by the adapter contract suite from messaging/001, and passing that suite is the real acceptance bar here.

Two details from the provider matter and are easy to get wrong: messages belong to a named message stream, and transactional and broadcast streams behave differently for deliverability and reporting — so the stream must be configurable with a sensible transactional default. And the provider distinguishes a request that failed at the HTTP level from one that returned a success status carrying an error code in the body; both are failures, and only the transport-shaped ones are retryable.

## Requirements

- The adapter is registered under a stable provider name and is selectable through the delivery mode without any caller change.
- Its configuration is server-side only: the server token, the sending address, an optional reply-to address, and the message stream, with a transactional stream as the default when unset. The token is a secret and follows the project's existing secret-handling rules — never in a browser bundle, a response, a log, a metric, or a committed file.
- The configuration check reports ready only when at minimum the token and the sending address are present, and the missing-configuration description names what is absent without revealing any value.
- A successful send returns the provider's message identifier and the stream the message was sent on, so later delivery investigation has something to correlate against.
- Failures are classified per the boundary's rules: provider rate limiting and server-side errors are retryable, a rejected or invalid recipient and a malformed request are not, and transport and network problems are retryable.
- An error body that arrives with a success-shaped response is still treated as a failure, with the provider's error code preserved as the stable code.
- Provider error text is sanitized and length-bounded before being returned, and no recipient address, message body, or token is written to logs.
- The send is time-bounded, and the transport is the injectable one from messaging/001 so every behavior above is verified without network access.
- The adapter passes the adapter contract test suite from messaging/001 in full.
- The provider's request and response shape used here is recorded in the task's tests as the contract being coded against, so a future provider change is visible as a test change.

## User-Facing Behavior

None directly — this is what makes every later message actually arrive.

## Interface Contract

- Implements the adapter contract from messaging/001 with no additions to it; the boundary's result union is the only outcome vocabulary it produces.
- Configuration is read from server-side settings only; no configuration reaches this adapter from a caller, a request, or a client.
- Consumed only through the delivery boundary; nothing outside this adapter refers to the provider by name.

## Acceptance Criteria

- [ ] The adapter is selectable by name and through automatic mode, with no caller referencing the provider.
- [ ] With the token and sending address present it reports configured; with either absent it reports unconfigured and names what is missing without leaking values.
- [ ] A successful send returns the provider's message identifier and the resolved message stream, defaulting to the transactional stream when unset.
- [ ] Rate-limit and server-error responses classify as retryable; rejected recipients and malformed requests classify as terminal; network failures classify as retryable.
- [ ] An error code returned inside a success-shaped response is treated as a failure carrying that code.
- [ ] No token, recipient address, or message body appears in any log, and provider error text is sanitized and length-bounded.
- [ ] The adapter passes the messaging/001 adapter contract suite in full.

## Verification

Adapter tests drive every path through a stubbed transport — success with message identifier and stream, missing configuration, rate limiting, server error, rejected recipient, malformed request, embedded error code in a success-shaped response, network failure, and timeout — asserting the classified result and the absence of secrets and personal data in emitted logs; the messaging/001 contract suite runs against this adapter and passes. The workspace typecheck and the services test command exit 0.
