# Messaging operations

How PackScout sends transactional email, what configures it, how to find out whether a message arrived, and what this layer deliberately does not do.

Related: [closed-beta operations](closed-beta-operations.md) for the access decisions that produce some of these messages, and `.tasks/messaging/scenarios/messaging.feature.md` for the behavior scenarios and their coverage.

## What sends what

| Message | Produced by | Reaches |
|---|---|---|
| Operational alert, and its recovery notice | The operational notification boundary, when an alert at a notifying severity is published | Configured operator addresses |
| Beta access approved / declined | An administrator's decision in the admin Users area | The product user, if their identity carries a verified address |
| Welcome | The welcome dispatcher, at an identity's first admitted session | The product user, once ever |
| Operator password reset | An operator's own request on the admin sign-in screen | The operator's address |
| Operator invitation | An administrator creating an operator | The invited address |
| Operator account created | An administrator directly creating an active operator with an initial password | The new operator's address; the message links to admin sign-in and says to obtain the initial password through a separate secure channel |

Nothing is sent inline. Every message is enqueued as a durable intent and delivered by the worker's outbox drain, so a provider outage delays messages instead of losing them.

## Configuration

None of these belong in a browser-visible variable. No value here is prefixed `NEXT_PUBLIC_`, and the provider token in particular must never reach a client bundle.

### Delivery boundary — worker and admin server

| Variable | Default | What it does | Missing or wrong |
|---|---|---|---|
| `PACKSCOUT_EMAIL_DELIVERY_MODE` | `auto` | `auto` uses the default adapter, `disabled` sends nothing, `console` renders locally instead of sending, or name an adapter (`postmark`) to force it | An unrecognized value resolves to `auto` rather than failing |
| `PACKSCOUT_EMAIL_REQUIRE_DELIVERY` | unset | Set to `1` to treat the environment as production-like, so an unconfigured adapter fails readiness instead of degrading | Unset means local `auto`/`console` are considered ready |

### Provider — worker and admin server

| Variable | Default | What it does | Missing or wrong |
|---|---|---|---|
| `POSTMARK_SERVER_TOKEN` | none | The provider server token. **Secret.** | Adapter reports unconfigured; sends fail closed naming the absent variable, never its value |
| `POSTMARK_FROM_EMAIL` | none | The sending address | As above — both token and sending address are required |
| `POSTMARK_REPLY_TO_EMAIL` | unset | Optional reply-to | Omitted from the request |
| `POSTMARK_MESSAGE_STREAM` | `outbound` | The provider message stream; the default is the transactional stream | Blank falls back to `outbound` |

### Message links — worker and admin server

| Variable | Default | What it does | Missing or wrong |
|---|---|---|---|
| `PACKSCOUT_PUBLIC_ORIGIN` | none | Absolute origin for product links in user-facing messages | Rendering reports an explicit failure rather than emitting a relative or broken link; the intent rests terminally failed |
| `PACKSCOUT_ADMIN_PUBLIC_ORIGIN` | none | Absolute origin for admin links (alerts, reset, invitations, direct-account notices) | As above |

### Alert routing — worker and admin server

| Variable | Default | What it does | Missing or wrong |
|---|---|---|---|
| `PACKSCOUT_ALERT_EMAIL_ENABLED` | enabled | `0`/`false`/`off`/`no` disables alert email entirely | An unrecognized value stays enabled and records a problem code |
| `PACKSCOUT_ALERT_EMAIL_RECIPIENTS` | unset | Comma-separated operator addresses, deduplicated, capped at 16 | Unset means alerts persist to the admin as before and the absence is logged where operators can see it |
| `PACKSCOUT_ALERT_EMAIL_SEVERITIES` | `warning,critical` | Which severities produce email | Informational alerts stay admin-only by default |
| `PACKSCOUT_ALERT_EMAIL_WINDOW_MS` | `21600000` (6h) | Flood-control window; repeats inside it produce no new message | Bounded to 60s–7d; out-of-range values fall back to the default |

### Outbox drain — worker

| Variable | Default | What it does |
|---|---|---|
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_BATCH_SIZE` | `25` | Intents claimed per pass |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_PER_RECIPIENT_LIMIT` | `5` | Per-pass cap per recipient, so one backlog cannot monopolize a cycle |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_LEASE_MS` | `60000` | Claim lease; a crashed drain's claims lapse and are retried |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_MAX_ATTEMPTS` | `6` | Attempts before an intent rests terminally failed |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_BASE_MS` | `30000` | First retry delay; doubles per attempt |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_CAP_MS` | `3600000` (1h) | Maximum retry delay |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_POLL_MS` | `5000` | Drain cadence |
| `PACKSCOUT_WORKER_MESSAGE_OUTBOX_RETENTION_DAYS` | `90` | Age at which terminal history is pruned; live intents are never pruned |

### Welcome dispatch — worker

| Variable | Default | What it does |
|---|---|---|
| `PACKSCOUT_WELCOME_EMAIL_ENABLED` | enabled | Turns the welcome message off without affecting any other kind |
| `PACKSCOUT_WORKER_WELCOME_DISPATCH_BATCH_SIZE` | `10` | Identities claimed per pass |
| `PACKSCOUT_WORKER_WELCOME_DISPATCH_LEASE_MS` | `300000` | Claim lease before a lapsed claim returns to discovery |
| `PACKSCOUT_WORKER_WELCOME_DISPATCH_POLL_MS` | `60000` | Discovery cadence |

The dispatcher reaches the product backend through `PACKSCOUT_ADMIN_DIRECTORY_URL` and `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` — the same server-to-server integration the admin uses. Unusable configuration idles the job; it never fails the worker.

### One-time links — admin server

| Variable | Default | What it does | Missing or wrong |
|---|---|---|---|
| `PACKSCOUT_EMAIL_LINK_TOKEN_SECRET` | none | **Secret**, at least 32 bytes. Keys the stored verifier hashes | Password reset and operator invitation creation both report unavailable (503) rather than creating an account nobody can be told about |
| `PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS` | 1 hour | Password-reset link lifetime | |
| `PACKSCOUT_EMAIL_LINK_INVITATION_LIFETIME_MS` | 7 days | Invitation link lifetime | |
| `PACKSCOUT_EMAIL_LINK_ISSUANCE_WINDOW_MS` / `_BLOCK_MS` | 15 min | Rate-limit window and block duration | |
| `PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW` | `5` | Reset requests per address per window | |
| `PACKSCOUT_EMAIL_LINK_RESET_SOURCE_MAX_PER_WINDOW` | `30` | Reset requests per source per window | |
| `PACKSCOUT_EMAIL_LINK_INVITATION_ADDRESS_MAX_PER_WINDOW` | `5` | Invitations per address per window | |
| `PACKSCOUT_EMAIL_LINK_INVITATION_SOURCE_MAX_PER_WINDOW` | `30` | Invitations per source per window | |

Changing the token secret invalidates every outstanding link. That is the deliberate emergency lever if links are believed compromised.

## Runbook

### Did a message actually go out?

Open **Messages** in the admin (requires `message_delivery:view`). The header shows how many intents are pending, retrying, and failed. Filter by state or kind, or search the exact recipient address. Opening an intent shows every attempt: when it ran, which provider, the outcome, the stable error code, and the provider's own message identifier for a successful send — use that identifier to find the message in the provider's dashboard.

### What the delivery states mean

| State | Meaning | Action |
|---|---|---|
| `pending` | Enqueued, waiting for its turn or its retry delay | None; the drain will take it |
| `retrying` | At least one retryable failure; backing off | None unless it persists past the attempt limit |
| `sent` | The provider accepted it and returned a message identifier | Delivery beyond acceptance is the provider's record, not ours |
| `skipped` | Deliberately not sent — delivery disabled, console mode, or missing configuration | Expected locally; in production it means configuration is absent |
| `failed` | Terminal. Attempts exhausted, or a non-retryable refusal, or a rendering failure | Fix the cause, then retry from the admin |

Common provider error codes: `EMAIL_POSTMARK_ERROR_300` (invalid address — terminal), `EMAIL_POSTMARK_ERROR_406` (inactive recipient, usually a prior hard bounce — terminal), `EMAIL_POSTMARK_ERROR_401`/`_10` (bad token — terminal, fix configuration), `EMAIL_POSTMARK_ERROR_429` and `_5xx` (retryable), `EMAIL_POSTMARK_TRANSPORT_FAILED` (network or timeout, retryable), `EMAIL_POSTMARK_RESPONSE_INVALID` (the provider answered without confirming success — treated as an unconfirmed send and retried). Rendering failures surface as catalogue error codes and are never retried automatically, because they will not improve on their own.

### Retry a failed message

In **Messages**, open the failed intent and choose Retry (requires `message_delivery:manage`). It re-enters the normal queue and the worker delivers it on the next pass. Only terminally failed intents can be retried; the action is audited. Fix the underlying cause first — retrying an invalid address just fails again.

### Change who receives operational alerts

Set `PACKSCOUT_ALERT_EMAIL_RECIPIENTS` on the worker and admin server and restart them. Recipients are resolved at send time, so a departed operator stops receiving mail as soon as the list changes. To stop alert email entirely without touching any other message, set `PACKSCOUT_ALERT_EMAIL_ENABLED=0`.

### Turn one message kind off

| Kind | Switch |
|---|---|
| Operational alerts | `PACKSCOUT_ALERT_EMAIL_ENABLED=0` |
| Welcome | `PACKSCOUT_WELCOME_EMAIL_ENABLED=0` |
| Everything | `PACKSCOUT_EMAIL_DELIVERY_MODE=disabled` — intents are still recorded, as `skipped` |

Access decisions and operator account messages have no individual switch: they are consequences of an operator action, and silently disabling them would leave people waiting for a message that is never coming. Use `disabled` mode if you must stop all sending.

## Local development

Set `PACKSCOUT_EMAIL_DELIVERY_MODE=console`. Every message kind then renders to the local log at delivery time — subject, plain-text body, and HTML — and the intent is recorded as `skipped` with reason `console_mode`. No provider account, no token, and no real send is involved, and the admin's Messages area still shows the full intent and attempt history. This is the supported way to see exactly what any message would say.

To exercise a specific kind: operational alerts by triggering a pipeline failure; access decisions and welcome through the admin Users area and a product sign-in; reset from the admin sign-in screen; and invitation or direct account creation from the Operators area. The direct-account message always links to `/login`; its stored rendering input contains only the recipient address, never an initial password or password hash.

## Adapters

The delivery boundary resolves an adapter by name from a registry with one default. Today exactly one is registered: `postmark`.

Adding another means implementing the adapter contract — a stable name, a configuration check, a description of what is missing when it is not configured, and a send operation returning the closed result vocabulary (sent with the provider's message identifier, skipped with a reason, or failed with a stable error code, sanitized message, and a retryability flag) — and registering it. No calling code changes.

The bar is mechanical: every adapter must pass the shared adapter contract suite, which checks configuration reporting, all three result shapes, retryability classification per failure class, sanitation of provider error text, and timeout behavior. An adapter that violates any of these fails the suite, and the suite runs in `npm run test:services`.

## What this layer deliberately does not do

### Bounces and spam complaints are not observed

There is no webhook ingestion and no suppression list. Consequences, stated plainly:

- A hard-bounced address stays in the system and will be mailed again. The provider may refuse it (`EMAIL_POSTMARK_ERROR_406`), which surfaces as a terminal failure in the Messages area — that is the only signal you get.
- A spam complaint is invisible to PackScout entirely.
- Repeatedly mailing dead addresses damages sending reputation over time.

What already exists for closing this gap later: every attempt records the provider's message identifier and its outcome, so webhook events can be matched to the intent that produced them without a migration. Suppression would then be a check at enqueue and a state on the recipient.

### There is no preference centre

Every message in this layer is transactional — each one is the consequence of an action the recipient or an operator took. There is no unsubscribe path and no per-recipient preferences, and the catalogue enforces this structurally: a message kind must declare itself transactional, and a promotional kind cannot be declared without an unsubscribe path. Do not add marketing email on top of this layer until that path exists.

### Not included

No SMS, push, in-product inbox, or chat delivery. No inbound email or reply handling — no message invites a reply the product can service. No digests, newsletters, or scheduled summaries. No localization. No operator-authored message copy at runtime: message content lives in the catalogue and changes through the codebase.
