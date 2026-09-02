# Local isolated-provider continuous polling

This resident local operator utility polls an already caught-up provider again
from its committed opaque head checkpoint. It does not reset source position,
adopt somebody else's active backfill, resume paused/stopped/error state, repair
permanent failures or change configuration. Its default execution has no EV or
publication step. Initial activation is
explicit and belongs to the integration operator, not automated reporting.

The installed DataForrest registry supplies all four supported providers. The
existing bounded gateway resolves each isolated database and credentials from
central configuration. The default local control route is
`127.0.0.1:55431/packscout`; local provider ports are Clutchpacks 55432, Courtyard
55433, Collector Crypt 55434 and Phygitals 55435. The existing explicit remote
runtime policy also admits pinned Neon control/provider hosts with verified TLS.
That policy does not permit arbitrary environment DSNs, source tokens, lane
overrides or the legacy 5432/import-runtime route.

Scope/removal: this local utility is owned by the distributed-ingestion operator.
Replace/remove it when a reviewed provider-local resident scheduler offers the
same durable cycle, fencing, operator-control and checkpoint guarantees. The
addition of Clutchpacks to the existing local backfill registry enables its
already-installed adapter; no generic retry classification changes.

## Activation

Use the coherent reviewed worker tree, including the matching canonical/EV
translation changes for providers that require them. A source registry alone is
not evidence that running an older mapper is safe. Preserve all existing
canonical, quarantine, page, run and EV history.

Select one new operation UUID and reuse every pin, cadence and post-head policy
on restart. New operations write version-2 receipts; legacy receipts are not
adopted as executable version-2 operations. The initial run
must be the latest verified succeeded/source-head run, with idle runtime,
matching current central/cache configuration, no active work or actionable
commands, and no owned import lease. Its non-null runtime checkpoint must match
the final run and final committed head page. A null origin is intentionally
refused. Stop at any changed authority, revision, membership, topology or cursor.

```bash
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx \
  scripts/local/run-provider-continuous-poller.mts --check-only \
  --organization-id ORGANIZATION_UUID --provider-id PROVIDER_UUID \
  --provider-key PROVIDER_KEY --config-id CONFIG_UUID \
  --initial-run-id VERIFIED_HEAD_RUN_UUID --operation-id NEW_OPERATION_UUID \
  --operator-id ACTIVE_ADMIN_UUID
```

`--check-only` resolves current authority and durable state, reports IDs/hashes,
cadence/disposition and the residency port, and performs no source call, database
write, subprocess launch or residency claim. Review it, then explicitly replace
`--check-only` with `--run` using the same pins. Root integration owns detachment,
private log location and actual live verification. This implementation never
detaches another hidden process or launches a worker during import/testing.

## Ownership and cadence

The resident process holds an exclusive loopback TCP listener for the provider:
56432–56435 respectively. A collision prevents all queue/worker actions. This
small health listener returns newline-delimited JSON with only provider/operation
IDs, PID, observation time, state, cadence, effective interval, post-head policy,
optional run/due time and bounded error code.
It accepts no commands. It is **not HTTP**, not an admin route, and does not prove
source advancement. Normal OS process inspection can corroborate its PID. The
kernel releases the port on process death; no stale PID file is deleted.

The listener is local process exclusivity, not database execution authority.
Existing provider import leases/fences remain authoritative. A live/foreign
backfill lease is never stolen. An old child surviving parent death remains
protected by that lease; restarting cannot launch a competing child while it is
live. Only the existing exact-operation expired-lease recovery can continue it.

By default, after each verified head the next run is due after the greater of
central `scheduleSeconds` and the installed DataForrest `poll_after` minimum of
60 seconds. An explicit `--poll-interval-seconds 60` selects a 60-second operational
cadence; accepted values are whole seconds from 60 through 86,400. This changes
only the resident operation. It does not revise source configuration, reset the
checkpoint or change source credentials. Check-only reports both the immutable
central interval and the effective interval.

Custom cadence and post-head callbacks are head-only: combining either with
`--bootstrap-backfill` refuses before authority or source work. Bootstrap retains
its existing central cadence without a callback; once caught up, an operator can
start a new, explicitly pinned head-only operation with the custom policy.

The interval starts at the preceding head's finish time, not at its start. Runs
remain sequential; import duration, an optional awaited post-head step and
database observations can delay the next start. A 60-second interval does not
promise a completed import every wall-clock minute. The clock is provider
database time. Waits recheck at most every 15 seconds and
are abortable. Empty successful head pages can schedule another cycle at the same
opaque checkpoint; they are not treated as completion of the live feed.

Before waiting or invoking a post-head step, startup persists an immutable
version-2 operation receipt binding all pins, authority, cadence, effective
interval and post-head policy. Every due cycle binds the same policy fields in
its immutable version-2 receipt, together with parent
run, full-checkpoint hash, generation, authority digest, due time and deterministic
new command/run/cycle-operation IDs. The exact saved checkpoint is copied by the
existing `requestRunNow` repository with hash/value/generation/config checks,
`requireNoActiveRun: true`, and the acquired import owner/fence checked atomically
under the queue transaction's lease lock. The request is a normal audited manual run; its parent
relationship lives in the cycle receipt, not fabricated recovery lineage.

Each owned cycle runs through the existing backfill supervisor under its distinct
deterministic operation ID. Its existing explicit timeout/network/rate-limit/
server-error policy and page-bound continuation are reused. Config, request
limits, fencing, child-close proof and checkpoint controls are unchanged. A new
head ends that cycle, not the resident poller.

An integration may supply an optional `postHead` registration to
`runContinuousPoller`. It receives only a verified, frozen summary of the exact
idle, succeeded head with a released lease, including its runtime row version.
The resident awaits that callback before persisting or queueing another cycle,
then reads current authority and state again. The callback implementation owns
its durable idempotency and receipts; it can be invoked again after a restart.
The poller itself contains no provider-specific publication behavior.

The registration requires a SHA-256 policy fingerprint and a timeout of
1–900,000 milliseconds. The operation and cycle receipts bind both; removing the
callback or changing its fingerprint/timeout on the same operation refuses
before queueing or leasing. Timeout or cancellation requests abort, then drains
the callback before rejecting. A callback that ignores cancellation blocks
further imports until it settles; it is never detached to allow overlapping work.
Any callback failure latches the resident blocked. A production wrapper must pin
its implementation and settings, durably reconcile uncertain outcomes, and
return successfully only after its own verification completes.

A wrapper may additionally register a read-only `beforeSource` admission check.
The resident awaits it immediately before persisting a due cycle, queueing it or
executing its nested backfill. This lets the wrapper refuse deployment or frozen
environment drift that occurs during a cadence wait. Any rejection latches the
same blocked state without the pending source action. Check-only invokes neither
the admission check nor the post-head callback.

## Controls and crash gaps

- **Paused:** resident waits without queueing/resuming/launching. An operator must
  resume explicitly. If pause interrupted an active cycle or invalidated an
  already-persisted generation pin, a new reviewed recovery is required; this
  utility does not reinterpret that incomplete attempt as a source head.
- **Stopped, SIGTERM, SIGINT or explicitly signalled child:** stop without restart.
- **Permanent/unknown failure or authority/control error:** latch resident
  `blocked`, issue no future queue/source work, and continue bounded read-only
  observations. An explicit operator restart/review is required. A live health
  listener in this state must not be described as a healthy feed.
- **Known provider-read connection unavailability:** remain `read_unavailable`,
  wait 15 seconds and revalidate authority/checkpoint before work. A timed-out
  read's callback must settle before any further read starts; its late snapshot
  is discarded. Identity/credential/authority errors, unknown database exceptions
  and all queue/write/child failures do not gain this retry capability. Read
  unavailability never clears a previously latched permanent failure.
- **Receipt before queue:** restart recognizes the exact receipt and queues once.
- **Utility lease before queue:** wait out its normal 120-second expiry, then only
  that exact receipt-owned expired lease may be fenced through the normal lease
  repository. No force-clear operation exists.
- **Queue committed before acknowledgement/release:** recognize its exact
  command/run/config/requested-cursor provenance; wait out an owned live utility
  lease if needed; fence/release only its expired lease, without another run.
- **Child progress before supervisor restart:** reuse the cycle's backfill
  receipts and existing fenced recovery. Do not change initial run/operation pins
  or infer ownership from a historical PID.

No transaction is held during the source request or cadence wait. A failed
transaction is awaited, not raced against a timer to launch overlapping work.

## Acceptance map and verification

| Given / when / then | Coverage |
| --- | --- |
| Verified head becomes due; one next run uses its exact checkpoint; repeated head keeps polling at central/source cadence | Automated: `provider-continuous-policy.test.mjs`, `provider-continuous-persistence.test.mjs` |
| Explicit 60-second operation preserves source configuration/checkpoint; missing or changed policy refuses replay before writes | Automated: continuous policy/persistence and `provider-launchd-plan.test.mjs` |
| Post-head callback is awaited once per observed head before the next cycle; cancellation drains and unknown failure blocks | Automated: `provider-continuous-post-head.test.mjs`, continuous policy tests |
| Another resident owns the loopback port; startup refuses without launching | Automated: policy test with real ephemeral local TCP sockets |
| Provider is paused/stopped, permanently failed, changed configuration, at null origin, or has foreign work; no source work begins | Automated: policy/persistence and existing backfill tests |
| Process dies around receipt/queue/lease; restart cannot duplicate a run or steal a live lease | Automated: persistence tests, existing backfill restart tests |
| Queued child advances; acknowledgement replay still recognizes only the exact prior command/run | Automated: persistence tests |
| Import lease expires or becomes foreign after preflight; atomic queue writes no command/run | Automated: persistence tests |
| Read infrastructure is unavailable; bounded retries revalidate pins without overlapping a pending read or clearing permanent failure | Automated: `provider-continuous-read.test.mjs`, policy tests |
| Actual provider polls from its saved head and commits under the coherent worker tree | Manual gap: root-owned explicit live activation and checkpoint/counter audit; never performed by unit tests |

```bash
node --test scripts/local/provider-continuous-*.test.mjs \
  scripts/local/provider-backfill-supervisor*.test.mjs
npx tsc --noEmit --strict --allowJs --module nodenext --moduleResolution nodenext \
  --target es2023 --esModuleInterop --allowImportingTsExtensions --skipLibCheck \
  scripts/local/run-provider-continuous-poller.mts
npm run test:tooling
npm run verify:framework
```

The integration owner runs the full framework gate on the assembled changes;
focused synthetic tests do not substitute for that gate or claim live success.
