# Task: Establish the Message Delivery Boundary and Provider Adapters

**ID:** messaging/001
**Depends on:** none
**Blocks:** messaging/002, messaging/003, messaging/004
**Estimated scope:** medium
**Status:** done

## Objective

PackScout gains one abstract way to send a message, with delivery providers behind a named adapter contract — so the product code that wants to send something never knows which provider is configured, and swapping providers is configuration rather than a rewrite.

## Context

PackScout has no way to send a message to anyone. It has an abstract operational notification boundary that alerts are already published through, but that boundary only persists alerts for the admin to display — nothing leaves the building. Everything this feature wants to do, from operational alerts to account recovery, needs a delivery layer first.

The approved reference platform solves this with a shape worth porting exactly: a provider adapter carrying a name, a way to report whether it is configured, a description of what is missing when it is not, and a send operation; a registry that resolves a named provider with one default; and a delivery mode that is either automatic, explicitly disabled, a local console mode that renders the message instead of sending it, or an explicitly named provider. Readiness is resolved before anything is persisted, and fails closed in production-like environments so a deployment cannot quietly accept an account operation whose message can never be delivered.

The part worth adding beyond the reference is a **contract test suite that every adapter must pass**. An abstraction with one implementation is a guess; the way to make the seam real without building a second provider is to define the behaviors any adapter must exhibit — configuration reporting, success shape, failure classification, error sanitation, timeout behavior — and require each adapter to pass them.

## Requirements

- A provider adapter contract with: a stable name, a configuration check that reports whether the adapter can send with the current environment, a description of what configuration is missing when it cannot, and a send operation taking a rendered message and returning a structured result.
- A registry resolves adapters by name and has exactly one default. Registering an adapter is the only step needed to make it selectable; callers are never changed to add one.
- Delivery mode is resolved from server-side configuration and is one of: automatic (use the default configured adapter), disabled (send nothing), console (render the message to the local log instead of sending, for development), or an explicitly named adapter. An unrecognized value resolves to automatic rather than crashing.
- A readiness check answers whether a delivery-critical message can actually be delivered under the current configuration. In production-like environments, or when an adapter is explicitly named, an unconfigured adapter is not ready. Local development in automatic or console mode is ready.
- The send result is a closed set of outcomes: sent (with the provider's name and its message identifier when it supplies one), skipped (with the reason — delivery disabled, console mode, or missing configuration), or failed (with a stable error code, a sanitized message, and whether a retry could succeed).
- Failures classify retryability honestly: transport and network problems and provider-side rate limiting or server errors are retryable; a rejected recipient, a malformed message, or missing configuration is not.
- Provider error text is sanitized and length-bounded before it is recorded anywhere, and no credential, token, recipient address, or message body reaches a log or a metric through this layer.
- Every send is bounded in time; an unresponsive provider produces a retryable failure rather than an open-ended wait.
- The transport used to reach a provider is injectable, so adapter behavior can be verified without network access.
- A published adapter contract test suite defines the behaviors every adapter must satisfy — configuration reporting, the success and failure result shapes, retryability classification, error sanitation, and timeout handling. Adding an adapter that does not pass it fails the build.
- Nothing in this task sends a real message or knows what any message says; rendering belongs to messaging/003 and durability to messaging/004.

## User-Facing Behavior

None. This is the seam every later task plugs into.

## Interface Contract

- A rendered message handed to an adapter carries: the message kind, the recipient address, a subject, a plain-text body, and an HTML body.
- An adapter exposes `name`, a configuration check, a missing-configuration description, and `send(message, context)` where the context supplies the environment and the injectable transport.
- Delivery resolution exposes the current mode, the resolved adapter, and the readiness answer.
- The result union — sent / skipped / failed — is the only outcome vocabulary later tasks branch on; messaging/004 maps retryable failures to retries, and messaging/011 displays these outcomes.
- Consumers never name a provider; they ask the layer to send a rendered message.

## Acceptance Criteria

- [x] An adapter can be registered and selected by name, with one default, without changing any caller.
- [x] Each delivery mode behaves correctly: automatic uses the default adapter, disabled sends nothing and reports skipped, console renders locally and reports skipped, and a named mode uses that adapter.
- [x] An unrecognized mode value resolves to automatic instead of failing.
- [x] Readiness fails closed in production-like environments and when an adapter is explicitly named but unconfigured, and passes in local automatic or console mode.
- [x] Send results carry the documented shape for sent, skipped, and failed, with retryability classified correctly for transport, rate-limit, server-error, and rejection cases.
- [x] No credential, recipient address, or message body appears in any log or metric emitted by this layer, and provider error text is sanitized and length-bounded.
- [x] An unresponsive provider yields a bounded, retryable failure rather than hanging.
- [x] The adapter contract test suite exists, and an adapter that violates any contract behavior fails it.

## Verification

Tests in the shared services layer exercise the boundary with stub adapters: mode resolution for every mode including the unrecognized value, readiness in production-like and local environments, each result shape, retryability classification per failure class, sanitation of provider error text, timeout behavior, and the adapter contract suite passing for a conforming stub and failing for a deliberately non-conforming one. The workspace typecheck and the services test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md` (feature context, ported reference shape, and the three additions beyond it); `packages/services/src/operational-events.ts` and `packages/contracts/src/operations.ts` (the notification boundary email later attaches to and the repository's closed-vocabulary conventions — both untouched).
- Alignment: the adapter contract (`packages/services/src/email-delivery/adapter.ts`) carries a stable name, `isConfigured(env)`, a missing-configuration description, and `send(renderedMessage, { env, fetchImpl })`; the registry (`registry.ts`) resolves adapters by name with exactly one default (the first registered) and registration is the only step to make one selectable. Delivery mode resolves server-side from `PACKSCOUT_EMAIL_DELIVERY_MODE` as automatic, disabled, console, or a named adapter, with unrecognized values becoming automatic; console mode renders through an injectable local renderer and reports skipped. Readiness fails closed in production-like environments (`NODE_ENV=production`, or `PACKSCOUT_EMAIL_REQUIRE_DELIVERY=1` for preproduction opt-in — the repository marks production runtimes with NODE_ENV) and whenever a named adapter is unconfigured, and passes in local automatic or console mode. The result union lives in `packages/contracts/src/email-delivery.ts` as the closed sent / skipped (delivery_disabled, console_mode, missing_configuration) / failed (stable code, sanitized bounded message, retryable) vocabulary; retryability classifies transport, network, timeout, 429, and 5xx as retryable and rejected recipients, malformed messages, and missing configuration as not. Every send is time-bounded twice: the injected transport enforces a deadline and the boundary races the adapter itself. Provider error text is sanitized (addresses, credential-shaped content, control characters) and bounded to 200 characters, and the boundary's optional log hook carries only bounded content-free fields. The published adapter contract suite (`adapter-contract-suite.test-support.ts`) runs a 12-check behavior matrix; a conforming stub passes it in full and six deliberately broken variants each fail their check. No real provider adapter, no message content, and no queueing ship in this task.
- Divergences: (1) The delivery mode is a discriminated union (`auto | disabled | console | adapter(name)`) rather than a bare string, so consumers cannot confuse a mode word with an adapter name; mode words are also reserved against registration. (2) The contract suite and the stub adapter live in `.test-support.ts` modules excluded from the runtime barrel, keeping node:test and node:assert out of runtime consumers; the Postmark task imports the suite by relative path inside the services package. (3) Readiness reports its reason from the skip vocabulary instead of one collapsed diagnostic code, and local disabled mode reports ready, matching the ported reference's local semantics. (4) Beyond the reference, an adapter called while unconfigured must itself fail closed with its missing-configuration code — the suite enforces it. (5) The boundary maps a thrown adapter error to a retryable failure and an unrecognized result shape to a non-retryable one, so `send` never rejects.
- Verification: `npm run typecheck:contracts && npm run test:contracts && npm run lint:contracts` → exit 0 (148 tests passed, including 6 in `src/email-delivery.test.ts`); `npm run typecheck:services && npm run test:services && npm run lint:services` → exit 0 (432 unit + 1 volume tests passed, including 45 under `src/email-delivery/`: the 12 contract-matrix checks against the conforming stub, 6 broken-stub rejections, 1 matrix-breadth guard, 18 delivery-service, 3 registry, and 5 transport tests); `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new findings, no grown modules; `npm run check:boundaries` → exit 0 (692 files).
