# Task: Trigger Distributed Jobs Immediately and Reconcile on Schedule

**ID:** convex-promotion-jobs/005
**Depends on:** convex-promotion-jobs/003, convex-promotion-jobs/004, distributed-canonical-warehouse/010
**Blocks:** convex-promotion-jobs/006, convex-promotion-jobs/009
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Deliver low-latency at-least-once provider and manifest invocations while
keeping durable provider-local and central intents as the correctness source.

## Requirements

### Provider-local wake and admission

- A provider canonical transaction coalesces only its own publication wake in
  the same transaction as material `promotion_changes`.
- `change_wake`, one-minute `reconciliation_cron`, `manual`, and
  `continuation` use one provider-local admission/invocation path.
- Trusted routing uses provider ID and the verified locator/gateway or a
  deployment-pinned provider identity; no caller selects a provider key,
  database, URL, host, credential, organization, or deployment.
- Schedule lifecycle is independently
  `pending_activation | active | paused`, with a monotonic epoch, trusted
  baseline, 60-second minimum/default, server-derived window, and check-in.
- Pause stops cron only. Durable wakes, manual commands, continuation, and other
  providers remain independent.

### Completion relay

- Provider completion/reuse and its typed outbox event commit atomically in the
  provider database.
- Existing at-least-once activity relay validates and deduplicates the event in
  central. Central acceptance atomically coalesces one per-provider manifest
  gate generation.
- Provider publication can complete while central is unavailable. Duplicate,
  delayed, lost-acknowledgement, and restart relay paths converge.
- Central scheduled reconciliation may repair missing delivery by exact bounded
  provider observation; it never guesses from timestamps.

### Central manifest scheduling

- One central schedule invokes the manifest coordinator. Pending work is one
  durable generation per provider and is fairly/boundedly selected.
- A failed or unreachable provider remains pending without blocking another
  provider gate.
- Immediate adapters contain no hosting-vendor, provider-specific, credential,
  or publication branch. Delivery acknowledgement does not erase authoritative
  work.
- A 50-second exit records continuation before closing the invocation.

### Trusted replay

- Authenticate entry path and bind authority/job/expiry before looking up the
  scoped delivery digest.
- A retained key returns `existing`; a live tombstone returns
  `existing_pruned`; an expired key performs no action.
- Unknown keys must match current wake generation, active schedule epoch/window,
  durable continuation, or protected manual command identity before check-in,
  lease, or Convex access.
- Manual provenance is protected outside monitoring responses.

## Acceptance Criteria

- [x] A provider commit atomically creates only its own wake; rollback creates
  neither change nor wake.
- [x] Lost immediate delivery is repaired by that provider's next one-minute
  schedule without affecting another provider.
- [x] Provider completion succeeds during central outage and relay replay yields
  one central inbox fact and one gate generation.
- [x] A newer local or central generation remains pending after an older run.
- [x] Duplicate/reordered/overlapping delivery from all four triggers creates no
  duplicate publication or manifest artifact.
- [x] Same-key/tombstone/expiry and cross-scope refusal semantics hold
  independently in provider and central authorities.
- [x] Providers can be added dynamically, including more than eight; one
  schedule can pause/resume without altering another.
- [x] Advancing provider A preserves provider B's manifest entry exactly; A
  failure leaves B usable.
- [x] Forged route, trigger, epoch/window, generation, or manual identity fails
  before check-in, lease, relay acknowledgement, or Convex request.
- [x] Shipping split-job code contains no fixed roster, `platformKey` routing,
  all-provider command, global readiness barrier, `clear` authority, legacy
  shared client, or cross-database transaction.

## Verification

Run provider/central migration tests, admission/replay/schedule repository tests,
relay duplicate/outage/restart tests, immediate-delivery-drop tests, dynamic
provider lifecycle and outage-isolation worker tests, A/B manifest preservation
tests, service/worker/database typecheck/lint, and the framework ratchet.

## Spec Compliance

No trigger delivery is a source of truth. Provider and central work remain
separate even when one process hosts both adapters.

Provider canonical writes atomically coalesce the durable wake; immediate
delivery is post-commit and lossy by design, while the one-minute schedule,
relay replay, and continuation paths repair loss. Production source-to-canonical
deployment belongs to the upstream provider-import feature; this task owns the
canonical PostgreSQL-to-Convex trigger path.

The repository retains a deprecated, explicit preproduction-only ClutchPacks
canary with fixed-eight/composite helpers. Production and split-job entrypoints
do not import it, it is not a fallback authority, and Task 009 must prove it is
not enabled at cutover.
