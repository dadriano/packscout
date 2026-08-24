# Task: Author the Message Catalogue and Rendering

**ID:** messaging/003
**Depends on:** messaging/001
**Blocks:** messaging/005, messaging/006, messaging/007, messaging/008
**Estimated scope:** medium
**Status:** done

## Objective

Every kind of message PackScout sends is defined in one place — typed inputs in, a rendered subject with matching plain-text and HTML bodies out — so senders describe what happened and never assemble email by hand.

## Context

The delivery boundary (messaging/001) moves a rendered message; it does not decide what any message says. That is this task: the catalogue of message kinds, their typed inputs, and how each renders.

The approved reference platform models each kind as a typed input — an activation, a reset, an invitation — turned into a transactional message carrying a subject, a text body, and an HTML body. PackScout needs the same, for the kinds this feature sends: an operational alert to an operator, a beta access decision to a product user, a welcome to a newly admitted user, and the account-recovery and provisioning links for operators.

Two properties are non-negotiable and both are easy to lose. Every message needs a real plain-text body, not an HTML-stripped afterthought — some recipients and most security tooling read only that. And a message must never carry a secret it does not need: an alert summarizing a pipeline failure has no business quoting a provider credential, and the operational notification contract already refuses text that looks like one. That refusal has to hold on the way out too.

## Requirements

- Each message kind has a typed input describing the event in domain terms — what happened, to whom, and the few values the copy needs — never a pre-built subject or body handed in by a caller.
- Rendering produces a subject, a plain-text body, and an HTML body for every kind. The plain-text body is written as real prose that stands on its own, and both bodies convey the same information and the same actions.
- Messages share one visual and verbal identity: consistent sender presentation, a recognizable layout, and a footer identifying who is sending and why the recipient is receiving it.
- Any link in a message is absolute and built from a configured public origin. When no origin is configured, rendering reports that the message cannot be rendered rather than emitting a relative or broken link.
- No message embeds a credential, token value, session identifier, or raw provider error. Where a message must carry a one-time link, it carries the link only (messaging/008 owns the token inside it), and the link is never logged.
- Rendered content is checked against the same unsafe-text rules the operational notification contract already applies, so a message whose content looks like it carries a secret fails rendering rather than being sent.
- Subjects and bodies are length-bounded, and every value interpolated into HTML is escaped. Recipient-supplied or provider-supplied text is treated as untrusted input, never as markup.
- The HTML body renders acceptably in common mail clients: a simple, table-free-or-tolerant layout, no external stylesheet or script, no remote font, and images (if any) with meaningful alternative text and a design that still reads with images blocked.
- Messages carry the recipient's language-neutral plain wording; no message depends on a locale system this project does not have.
- Every message kind states whether it is transactional or promotional. All kinds in this feature are transactional in character, and any future promotional message must carry an unsubscribe path — this feature does not build a preference centre, so a promotional message cannot be added without one.
- Rendering is pure: given the same input it produces the same output, with no clock, network, or database access, so every kind is verifiable by snapshot.

## User-Facing Behavior

What people actually read. A recipient gets a message that identifies PackScout, says plainly what happened, gives them the one action that matters, and reads correctly whether their client shows HTML or plain text.

## Interface Contract

- A typed input per message kind, and one rendering entry point per kind producing `{ subject, textBody, htmlBody }` — the exact shape the delivery boundary from messaging/001 accepts.
- Rendering reports an explicit failure — it does not throw and does not emit a partial message — when a required value is missing or no public origin is configured.
- Consumers: messaging/005 (operational alerts), messaging/006 (access decisions), messaging/007 (welcome), and messaging/008 (one-time link messages) render through this catalogue and never construct message content themselves.
- Adding a message kind means adding an input type and a renderer here; no delivery, queueing, or adapter code changes.

## Acceptance Criteria

- [x] Every message kind in this feature has a typed input and renders a subject, a real plain-text body, and an HTML body conveying the same information and actions.
- [x] Links are absolute and origin-derived; with no configured origin, rendering reports failure instead of emitting a relative or broken link.
- [x] Content that would embed a credential, token value, or raw provider error fails rendering rather than being sent.
- [x] Interpolated values are HTML-escaped, and untrusted text cannot inject markup.
- [x] HTML bodies carry no external stylesheet, script, or remote font, and read correctly with images blocked.
- [x] Rendering is deterministic and side-effect free, and each kind is covered by a stable snapshot.
- [x] Every kind declares its transactional character, and a promotional kind cannot be added without an unsubscribe path.

## Verification

Rendering tests cover every message kind with stable snapshots of subject, text, and HTML; assert plain-text and HTML parity of information and actions; assert absolute link construction and the explicit failure when no origin is configured; assert HTML escaping against markup-bearing input; assert the unsafe-content refusal; and assert determinism. The workspace typecheck and the services test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/messaging/_index.md`; messaging/001 (the delivery boundary this catalogue renders for — untouched); the consumer specs messaging/005–008, plus 009 and 010 for the required content of the account-lifecycle messages; `packages/contracts/src/email-delivery.ts` (`renderedEmailMessageSchema`, the exact shape rendering must satisfy) and `packages/contracts/src/operations.ts` (the unsafe-text refusal this catalogue reuses and extends) — both contract files untouched.
- Alignment: the catalogue lives in `packages/services/src/message-catalogue/` beside the delivery boundary. Seven kinds ship in a typed registry (`catalogue.ts`, `emailMessageCatalogue`): `operational_alert`, `operational_alert_recovery`, `access_approved`, `access_declined`, `welcome`, `operator_password_reset`, `operator_invitation`. Each declares its audience, its footer reason, and `transactional: true`; the promotional branch of `EmailMessageCharacter` requires `unsubscribePath: never`, so a promotional kind cannot be constructed until a preference centre supplies a real unsubscribe-path type. One rendering entry point per kind — `renderOperationalAlertMessage`, `renderOperationalAlertRecoveryMessage`, `renderAccessApprovedMessage`, `renderAccessDeclinedMessage`, `renderWelcomeMessage`, `renderOperatorPasswordResetMessage`, `renderOperatorInvitationMessage`, each `(input, origins)` — returns either a complete `RenderedEmailMessage` validated against `renderedEmailMessageSchema` by the final gate in `rendering.ts` (so subject and body bounds are the delivery contract's) or an explicit failure (`EMAIL_MESSAGE_ORIGIN_MISSING`, `EMAIL_MESSAGE_INPUT_INVALID`, `EMAIL_MESSAGE_CONTENT_UNSAFE`, `EMAIL_MESSAGE_BOUNDS_EXCEEDED`) that never throws, never emits a partial message, and never echoes content into its reason. Plain-text bodies are written prose with a sig-separator footer identifying the sender and the receiving reason; both bodies carry the same facts and the same links. Links are absolute only: `origins.ts` is the catalogue's single origin-configuration read — the existing `PACKSCOUT_PUBLIC_ORIGIN` for product links and the new `PACKSCOUT_ADMIN_PUBLIC_ORIGIN` for operator links, validated origin-only and HTTPS (plain-HTTP localhost outside production) with the same rules the frontend applies to its origin variable — and renderers receive the resolved value instead of reading the environment, keeping rendering pure. One-time links arrive as opaque rooted paths, are re-anchored to the configured admin origin, and are never generated, inspected, or logged here. Interpolated prose is whitespace-normalized, HTML-escaped everywhere it lands (content, attributes, `<title>`), and refused when it matches the operational contract's unsafe-text rule extended with the delivery transport's credential shapes (assignments, API keys, hex blobs, JWT-like values, long opaque runs). Alert inputs reuse the alert vocabulary: severity via `operationalSeveritySchema`, title and summary at the operational 160/500 bounds, evidence codes on the stable-code alphabet (at most 8), and uuid alert identifiers linking to the admin's `/alerts/:alertId` route. HTML bodies are single-column, self-contained documents: inline styles only, and no image, script, stylesheet link, remote font, or `url(` anywhere, so they read identically with remote content blocked. Timestamps arrive as inputs and render through a fixed UTC formatter; no render path touches clock, randomness, network, or database.
- Divergences: (1) The recovery note is its own kind (`operational_alert_recovery`) rather than a flag on the alert input, so delivery history and the admin can tell the two apart at a glance. (2) `access_declined` is deliberately link-free per messaging/006's brevity requirement and therefore renders even with no origin configured; the origin-missing failure applies to every kind that carries a link. (3) Messages with expiring links state an absolute expiry instant (a `linkExpiresAt` input) rather than a relative lifetime, so the statement stays true whenever the message is read; issuance (messaging/008) owns the actual lifetime and passes the instant in. (4) The invitation takes the inviter's display name as an input; the caller (messaging/010) resolves who invited. (5) Per-kind input types live beside the renderers in the services package rather than in contracts — consumers must import the render functions from services anyway, and messaging/001 set the same precedent by keeping adapter types in services.
- Verification: `npm run typecheck:services` → exit 0; `npm run test:services` → exit 0 (489 unit + 1 volume tests passed in this shared worktree, 32 of them under `src/message-catalogue/`: 19 catalogue tests — pinned snapshots of subject, full text body, and HTML digest for all seven kinds, registry and transactional-character checks including the type-level promotional refusal, determinism plus a patched-clock/randomness purity check, text/HTML link-and-fact parity, markup-injection escaping, unsafe-content refusal, opaque one-time-link passthrough, per-kind origin-missing failures, invalid-input failures, HTML self-containment with images blocked, and maximal-input subject bounds — plus 9 rendering-core and 4 origin-configuration tests); `npm run lint:services` → exit 0; `npm run scan:framework-standards:ratchet` → exit 0 (0 findings, 0 new, 0 grown modules); `node scripts/check-docs.mjs` → exit 0 (155 markdown files); `npm run check:boundaries` → exit 0 (700 files).
