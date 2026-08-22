# Task: Author the Message Catalogue and Rendering

**ID:** messaging/003
**Depends on:** messaging/001
**Blocks:** messaging/005, messaging/006, messaging/007, messaging/008
**Estimated scope:** medium
**Status:** todo

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

- [ ] Every message kind in this feature has a typed input and renders a subject, a real plain-text body, and an HTML body conveying the same information and actions.
- [ ] Links are absolute and origin-derived; with no configured origin, rendering reports failure instead of emitting a relative or broken link.
- [ ] Content that would embed a credential, token value, or raw provider error fails rendering rather than being sent.
- [ ] Interpolated values are HTML-escaped, and untrusted text cannot inject markup.
- [ ] HTML bodies carry no external stylesheet, script, or remote font, and read correctly with images blocked.
- [ ] Rendering is deterministic and side-effect free, and each kind is covered by a stable snapshot.
- [ ] Every kind declares its transactional character, and a promotional kind cannot be added without an unsubscribe path.

## Verification

Rendering tests cover every message kind with stable snapshots of subject, text, and HTML; assert plain-text and HTML parity of information and actions; assert absolute link construction and the explicit failure when no origin is configured; assert HTML escaping against markup-bearing input; assert the unsafe-content refusal; and assert determinism. The workspace typecheck and the services test command exit 0.
