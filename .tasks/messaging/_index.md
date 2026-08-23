# Feature: Messaging

## Context

PackScout cannot send anyone a message. There is no email path in the workspace at all: operational alerts are detected, deduplicated, and persisted for the admin to display, but nothing leaves the building — an operator learns the pipeline died by opening the admin and looking. Product users have no way to be told anything, which is why the closed-beta feature had to defer notifying people of access decisions. Admin operators are provisioned by another administrator typing a password and passing it along, with no recovery path if they lose it.

This feature adds one delivery layer and the messages that ride on it. Postmark is the provider it starts with, behind a named adapter contract, so that the code deciding a message should be sent never knows which provider is configured and swapping providers is configuration rather than a rewrite.

### What already exists

- **An abstract operational notification boundary.** Alerts are published through a composite publisher interface that currently has exactly one member — durable persistence for the admin's alerts area. External delivery was deliberately deferred with the note that this boundary stands, waiting for a delivery layer. Email attaches as a second publisher; no alert producer changes.
- **A background worker with claim-based scheduling.** The pipeline's worker already claims due work, reports liveness, and runs retention. The delivery drain belongs alongside it rather than as a second scheduling mechanism.
- **Operator accounts with email addresses and administrator-set passwords**, a role and named-permission vocabulary, and audit conventions — everything the account-lifecycle messages build on.
- **Product-user records with sometimes-present verified email addresses.** Users sign in through a hosted wallet/social provider, so a wallet-only identity may expose no address at all. Having no way to reach someone is a normal state in this product, not an error.

### Ported from the approved reference platform

The reference already solves the abstraction well, and its shape is ported closely: an adapter carrying a name, a configuration check, a description of what is missing, and a send operation; a registry with one default; delivery modes of automatic, disabled, local console, or an explicitly named provider; readiness resolved before anything is persisted and failing closed in production-like environments; typed per-message inputs rendered into a subject with matching text and HTML bodies; and a closed result vocabulary of sent, skipped, and failed with retryability classified honestly. Its purpose-scoped, single-use, expiring, hashed token model is the basis for the operator account links.

Three things are added beyond the reference, because the reference does not have them:

- **An adapter contract test suite.** An abstraction with one implementation is a guess. Rather than build a second provider to prove the seam, every adapter must pass a published suite defining configuration reporting, result shapes, retryability classification, error sanitation, and timeout behavior.
- **A durable outbox.** The reference sends inline. PackScout enqueues: a provider outage delays messages rather than losing them, retries are bounded and backed off, and the same triggering event can never send twice.
- **Delivery visibility in the admin.** The reference records a delivery status on the record that triggered the send. PackScout gets a searchable delivery history with attempt-level outcomes, because "did they actually get it?" is the first question anyone asks.

### Decisions taken

- **Email only, with swappable providers.** One channel, several possible providers. No webhook channel, no in-app inbox.
- **Four message kinds ship:** operational alerts to operators, closed-beta access decisions, a welcome on first admitted sign-in, and the operator account-lifecycle links (password reset and provisioning invitation).
- **Bounce, complaint, and suppression handling is deferred.** The consequence is accepted and recorded rather than left silent: hard-bounced and complained addresses will keep being mailed, and neither event is observed. Provider message identifiers and per-attempt outcomes are recorded from day one so a later webhook ingestion has something to attach to.

### Relationship to the closed-beta feature

The closed-beta feature excluded notifying users of access decisions, reasoning that no email infrastructure existed and that the waiting surface updates live. That reasoning only covers someone with the page open. `messaging/006` supersedes the exclusion, and `messaging/012` updates the closed-beta index so the two specifications do not contradict each other.

## Tasks

### Delivery layer

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | Establish the message delivery boundary and provider adapters | medium | done | none |
| 002 | Add the Postmark delivery adapter | medium | done | 001 |
| 003 | Author the message catalogue and rendering | medium | done | 001 |
| 004 | Deliver messages durably with retries | large | done | 001 |

### Messages

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 005 | Route operational alerts to operators by email | medium | in_progress | 003, 004 |
| 006 | Notify product users of beta access decisions | medium | todo | 003, 004, closed-beta-access/003, closed-beta-access/010 |
| 007 | Welcome an admitted user on first sign-in | medium | todo | 003, 004, closed-beta-access/001 |

### Operator account lifecycle

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 008 | Issue and redeem one-time email links | large | in_progress | 003, 004 |
| 009 | Let operators reset their own password | medium | todo | 008 |
| 010 | Provision operators by invitation | medium | todo | 008 |

### Operability

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 011 | Inspect message delivery in the admin | medium | todo | 004, admin-tools/001 |
| 012 | Verify and operate the messaging layer | medium | todo | 002, 005, 006, 007, 009, 010, 011 |

## Build Order

1. 001 first and alone — it defines the adapter contract, the result vocabulary, and the contract test suite that everything else is written against.
2. When 001 lands, 002 (the Postmark adapter), 003 (message catalogue), and 004 (durable delivery) proceed in parallel. They touch different concerns and share only the contract from 001.
3. When 003 and 004 are both in, every message kind unblocks at once: 005, 006, 007, and 008 are independent of each other. 011 needs only 004 and can start as soon as it lands.
4. 009 and 010 follow 008; they are independent of each other and share its token mechanism.
5. 012 closes the feature.

004 is the largest and most subtle task — durability, idempotency, claiming, and backoff are where this kind of layer usually goes wrong — and everything except 002 waits on it. Start it first within step 2. 008 is the other one to give room: it is the security-critical piece, and 009 and 010 both sit on it.

Only the messages the beta actually needs are on the critical path. If the closed beta ships before this feature completes, 001, 003, 004, and 006 are the minimum that makes access decisions reach people.

## Parallel Groups

- Group A (no deps): 001
- Group B (after A): 002, 003, 004
- Group C (after B): 005, 006, 007, 008 (all need 003+004), 011 (needs 004)
- Group D (after C): 009, 010 (both need 008)
- Group E (after D): 012

## Out of Scope

- Bounce, spam-complaint, and delivery webhook ingestion, and any suppression list. Deliberately deferred; the consequence is that dead and complained addresses keep being mailed and neither event is observed. Recorded provider message identifiers and attempt outcomes are the hook a later implementation attaches to.
- A recipient preference centre or unsubscribe mechanism. Every message here is transactional; a promotional message cannot be added until this exists.
- Channels other than email — no SMS, no push, no in-product inbox, no chat or webhook delivery for alerts.
- Inbound email processing or reply handling. Messages are one-way; none invites a reply the product can service.
- Marketing campaigns, newsletters, digests, scheduled summaries, and audience segmentation.
- Localization or per-recipient language selection.
- Message content authored or edited by operators at runtime — message copy lives in the catalogue and changes through the codebase.
- Product-user notification settings, saved-search alerts, price-drop notices, or any catalogue-driven message to users.
- Changing PackScout's authentication model for product users; the hosted provider remains the identity system, and no message carries a sign-in token.
- Replacing the admin's existing password rules, session mechanism, or rate limiting; the account-lifecycle flows reuse them.
