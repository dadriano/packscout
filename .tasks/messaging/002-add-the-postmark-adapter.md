# Task: Add the Postmark Delivery Adapter

**ID:** messaging/002
**Depends on:** messaging/001
**Blocks:** messaging/012
**Estimated scope:** medium
**Status:** done

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

- [x] The adapter is selectable by name and through automatic mode, with no caller referencing the provider.
- [x] With the token and sending address present it reports configured; with either absent it reports unconfigured and names what is missing without leaking values.
- [x] A successful send returns the provider's message identifier and the resolved message stream, defaulting to the transactional stream when unset.
- [x] Rate-limit and server-error responses classify as retryable; rejected recipients and malformed requests classify as terminal; network failures classify as retryable.
- [x] An error code returned inside a success-shaped response is treated as a failure carrying that code.
- [x] No token, recipient address, or message body appears in any log, and provider error text is sanitized and length-bounded.
- [x] The adapter passes the messaging/001 adapter contract suite in full.

## Verification

Adapter tests drive every path through a stubbed transport — success with message identifier and stream, missing configuration, rate limiting, server error, rejected recipient, malformed request, embedded error code in a success-shaped response, network failure, and timeout — asserting the classified result and the absence of secrets and personal data in emitted logs; the messaging/001 contract suite runs against this adapter and passes. The workspace typecheck and the services test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md` (ported reference shape, contract-suite acceptance bar, stream/embedded-error provider details); `.tasks/messaging/001-establish-the-message-delivery-boundary.md` including its Spec Compliance section (the landed boundary this adapter implements against); the landed contract itself — `packages/services/src/email-delivery/adapter.ts`, `transport.ts`, `registry.ts`, `delivery-service.ts`, `adapter-contract-suite.test-support.ts`, `stub-adapter.test-support.ts`, and `packages/contracts/src/email-delivery.ts` — all consumed, none modified.
- Alignment: the adapter lives in `packages/services/src/email-delivery/postmark-adapter.ts` under the stable name `postmark`, exported through one appended line in `packages/services/src/index.ts`; `registry.register(createPostmarkEmailDeliveryAdapter())` is the single registration step messaging/004 composes, and the registration test proves name selection, automatic-default selection, and a boundary send in which no caller names the provider. Configuration is server-side only: `POSTMARK_SERVER_TOKEN` (secret) and `POSTMARK_FROM_EMAIL` required, `POSTMARK_REPLY_TO_EMAIL` optional, `POSTMARK_MESSAGE_STREAM` optional and defaulting to the transactional `outbound` stream; `isConfigured` reports ready only with token and sending address present, `missingPostmarkConfiguration(env)` names absent variables (names only, never values), and an unconfigured send fails closed before any transport use with `EMAIL_POSTMARK_UNCONFIGURED`. A successful send returns the provider `MessageID` (trimmed, bounded, else null) and the resolved message stream. The wire contract is coded and pinned in tests: POST `https://api.postmarkapp.com/email` with Accept/Content-Type `application/json` and the `X-Postmark-Server-Token` header, body `From/To/Subject/TextBody/HtmlBody/MessageStream` plus `ReplyTo` only when configured; success is an OK status confirming `ErrorCode: 0`; an error code embedded in a success-shaped response is a terminal failure preserving the provider code as `EMAIL_POSTMARK_ERROR_<code>`; HTTP failures use body `ErrorCode` else status as the stable code with retryability from `isRetryableEmailTransportStatus` (408/429/5xx retryable; rejected recipient 406 and invalid request 300 terminal); network and timeout failures are retryable `EMAIL_POSTMARK_TRANSPORT_FAILED` (a lost response may still have delivered — the outbox's idempotency accepts that bounded duplicate risk, and the closed result union gains no new field for it). All provider error text passes through `sanitizeEmailProviderErrorText`; the adapter writes no logs at all, proven by a console-capture test across the full send matrix; only the injected `fetchImpl` is ever used and every test transport is a fake. The messaging/001 contract suite runs in full against the adapter and passes (12/12 checks).
- Acceptance evidence (criterion → test in `packages/services/src/email-delivery/postmark-adapter.test.ts`): selectable by name and automatic mode → "postmark registration: one registration makes the adapter selectable by name and as the automatic default"; configuration reporting → "postmark configuration: ready only with token and sending address, naming what is absent without values" and "…unconfigured send fails closed before the transport, naming only the absent variable" plus the suite's configuration and unconfigured-send checks; message identifier and stream with transactional default → "postmark success: a delivered send carries the provider message identifier and the resolved stream" and "postmark stream: defaults to the transactional outbound stream and follows the configured override"; retryability classification → "postmark classification: HTTP failures use the body error code or status…" and "…network failures and transport timeouts are retryable transport failures" plus the suite's four classification checks; embedded error code → "postmark classification: an error code embedded in a success-shaped response is a terminal failure carrying that code"; sanitation and no-log → "postmark sanitation: provider error text is redacted and length-bounded…" and "postmark logging: no token, recipient address, subject, or body reaches any console output" plus the suite's sanitation check; full contract suite → the 12 "email delivery adapter contract (postmark)" tests; wire shape recorded → the two "postmark wire contract" tests pinning the exact request and response shapes.
- Divergences: (1) The sent result is narrowed, not widened — `PostmarkEmailSendResult` intersects the contract's sent variant with a `messageStream` field so the resolved stream is returned as required while the boundary's closed union is untouched; the delivery service's mapping ignores the extra field. (2) The contract's `missingConfiguration` description is static, so it names both required variables; the exact-per-environment naming lives on the fail-closed send result and `missingPostmarkConfiguration(env)`. (3) Success requires an explicit `ErrorCode: 0` — an OK status whose body does not confirm it is a retryable `EMAIL_POSTMARK_RESPONSE_INVALID` failure rather than an assumed delivery, carrying the same bounded duplicate-risk retry semantics as a lost response.
- Verification: `npm run typecheck:services` → exit 0; `npm run test:services` → exit 0 (457 unit + 1 volume tests passed; 70 under `src/email-delivery/`, of which 25 are in `postmark-adapter.test.ts`: the 12 contract-matrix checks against the Postmark adapter plus 13 adapter-specific tests); `npm run lint:services` → exit 0; `npm run scan:framework-standards:ratchet` → exit 0 (0 findings, 0 new findings, no grown modules); `node scripts/check-docs.mjs` → ok (155 markdown files); `npm run check:boundaries` → exit 0 (696 files).
