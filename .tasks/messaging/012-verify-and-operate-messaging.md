# Task: Verify and Operate the Messaging Layer

**ID:** messaging/012
**Depends on:** messaging/002, messaging/005, messaging/006, messaging/007, messaging/009, messaging/010, messaging/011
**Blocks:** none
**Estimated scope:** medium
**Status:** in_progress

## Objective

The messaging layer is proven end to end, the provider abstraction is demonstrated rather than asserted, and the layer can be configured, operated, and switched between providers by someone following documentation.

## Context

Each task verifies its own layer. What none of them proves is the claim the whole feature rests on: that PackScout can send the messages it needs to send, that no caller knows which provider is configured, and that swapping providers is configuration. An abstraction is only real once something has actually gone through it both ways.

This task also settles what the layer deliberately does not do. Bounce and spam-complaint handling was consciously deferred, which means hard-bounced and complained addresses will continue to be mailed and PackScout will not observe either event. That is an accepted risk, not an oversight, and it belongs written down where the next person will find it — along with what the layer already records that makes closing the gap later straightforward.

## Requirements

- An end-to-end behavior scenario set records the journeys the layer exists for, at minimum: an operational alert at a notifying severity produces one message and a flapping alert does not produce a stream; a waiting beta user approved by an administrator receives an approval message, and a declined one receives a decline; a newly admitted user receives exactly one welcome; an operator recovers their password through a mailed link and their existing sessions end; an invited operator activates and signs in; a terminally failed message is retried from the admin and succeeds; a provider outage delays rather than loses messages; and disabled and console modes send nothing while recording clean outcomes.
- Each scenario is marked as automated with its covering check, or as an explicit manual gap with the reason — no scenario implies coverage it does not have.
- The provider abstraction is demonstrated, not asserted: switching delivery mode between the console adapter and the provider adapter changes behavior with no caller change, and the adapter contract suite passes for every registered adapter. Which adapters exist and what a new one must satisfy is documented.
- Operational documentation covers every configuration value the layer depends on — delivery mode, the provider's token, sending and reply-to addresses, message stream, the public origin used for links, severity thresholds, alert recipients, flood-control window, retry limits, and token lifetimes — saying what each does, where it lives, that no provider token belongs in a browser-visible variable, and what the layer does when each is missing.
- A runbook covers the operational questions: how to check whether a message was delivered, how to interpret each delivery state and the common provider error codes, how to retry a failed message, how to change alert recipients, and how to turn any individual message kind off.
- The deferred deliverability gap is documented explicitly: that bounces and spam complaints are not observed, that there is no suppression list, that repeatedly mailing a dead address is therefore possible, and what the layer already records — provider message identifiers and per-attempt outcomes — that a later webhook ingestion would attach to.
- The absence of a recipient preference centre is documented with the same honesty: every message in this feature is transactional, and no promotional message can be added until a preference and unsubscribe path exists.
- A local development path is documented and works: a developer can exercise every message kind without a provider account or a real send, and can see exactly what would have been sent.
- The closed-beta feature's task index is updated where this feature supersedes it — its exclusion of decision notifications no longer holds — so the two feature specifications do not contradict each other.
- Documentation passes the repository's documentation checks.

## User-Facing Behavior

No new surface. The outcome is that messages arrive reliably, that an operator can find out what happened to any of them, and that changing provider is a configuration decision rather than an engineering project.

## Interface Contract

- The behavior scenario set lives where the repository keeps its behavior specifications, alongside this feature's task files, and names the coverage for each scenario.
- Operational documentation lives with the repository's existing operator documentation. This task adds no new configuration mechanism and no new capability; it documents and proves what the preceding tasks established.

## Acceptance Criteria

- [ ] The end-to-end scenario set exists with every listed journey covered, each marked automated with its check or as an explicit manual gap.
- [ ] Switching delivery mode between console and the provider adapter changes behavior with no caller change, and the adapter contract suite passes for every registered adapter.
- [ ] Every configuration value is documented with its purpose, location, browser-visibility rule, and missing-value behavior.
- [ ] The runbook covers delivery investigation, delivery states and common provider error codes, retrying, changing alert recipients, and disabling an individual message kind.
- [ ] The deferred bounce, complaint, and suppression gap is documented with its consequence and with what a later implementation would attach to.
- [ ] The absence of a preference centre is documented, with the rule that promotional messages cannot be added without one.
- [ ] A developer can exercise every message kind locally without a provider account and see what would have been sent.
- [ ] The closed-beta feature's index no longer contradicts this feature on decision notifications.

## Verification

The workspace's full verification command — lint, typecheck, tests, build, and the framework and documentation checks across the services layer, worker, admin, and product backend — exits 0, and the recorded end-to-end scenario set shows every listed journey either covered by a named automated check or marked as an explicit manual gap.
