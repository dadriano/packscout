# PostgreSQL-to-Convex Promotion Runbook

Status: production operator contract

This runbook governs the one approved PackScout organization and Convex
deployment pair. PostgreSQL remains canonical. Convex receives only bounded,
public release documents and aggregate Heat frames after settlement. No public
request, provider payload, or Convex mutation may select an organization.

## Safety model

- Canonical writes and their causal public-change sequence commit together in
  PostgreSQL.
- A watermark advances only through contiguous causes whose derivations reached
  either success or a valid business-unavailable outcome. A technical failure
  blocks settlement.
- Catalog publication is deterministic and immutable. The worker persists exact
  request bytes before sending, reconciles ambiguous sends by operation status,
  and changes the active pointer only after full count/hash reconciliation.
- A failed staged publication never replaces the prior complete release.
  Unchanged content advances observation freshness without duplicating release
  rows.
- Heat is a separate minute-boundary lane. Catalog activation never waits for
  Heat, and Heat must match the active catalog release or fail closed.
- Durable alerts contain only a lane, bounded condition/code/count/duration,
  public watermark strings, and a PostgreSQL attempt UUID. The server derives a
  domain-separated SHA-256 deployment-scope digest for dedupe and recovery keys;
  alert reads match organization, deployment digest, and lane exactly. The raw
  deployment key never enters notifications, logs, or portable evidence, and
  tenant binding stays in protected PostgreSQL columns.

## Production configuration contract

Configure secrets through the deployment secret manager. Never print, paste
into evidence, or commit their values.

| Setting | Contract |
|---|---|
| `NODE_ENV` | Must be `production` for the live worker. |
| `PACKSCOUT_DATABASE_URL` | Required PostgreSQL URL. Startup also requires the exact latest migration checksum and table count. |
| `PACKSCOUT_PUBLIC_ORGANIZATION_ID` | Required UUID for the single approved public organization. It is resolved at process startup and never accepted from a request. |
| `PACKSCOUT_CATALOG_DEPLOYMENT_KEY` | Required server-side deployment key matching `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`. The same value scopes both promotion lanes in PostgreSQL. |
| `PACKSCOUT_CONVEX_PUBLICATION_BASE_URL` | Required HTTPS origin only: no credentials, path, query, or fragment. |
| `PACKSCOUT_CONVEX_PUBLICATION_KEY_ID` | Required versioned key ID accepted by the Convex signing-key map. |
| `PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64` | Required canonical base64. It must decode to 32 through 256 bytes. |
| `PACKSCOUT_CATALOG_PROMOTION_POLL_MS` | Optional; default `5000`, allowed `1000` through `30000`. |
| `PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS` | Optional; default `10000`, allowed `100` through `30000`. Shared by catalog and Heat publication. |
| `PACKSCOUT_HEAT_RETENTION_BATCH_SIZE` | Optional; default `500`, allowed `1` through `1000`. |
| `PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE` | Optional; default `4`, allowed `1` through `20`. |
| `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` | Required in Convex. A strict JSON object mapping each versioned key ID to the same canonical-base64 secret configured on its worker. Unknown keys, malformed JSON, arrays, noncanonical base64, and decoded values outside 32 through 256 bytes fail closed. |
| `PACKSCOUT_DATA_RELEASE_CLEAR_ENABLED` | Must be absent in normal operation. Set to `1` only for an approved emergency clear and remove immediately afterward. |

The Heat scheduler runs at exact UTC minute boundaries and intentionally has no
poll-interval setting. Catalog activation alerting is fixed at 60,000 ms after
the settled watermark timestamp; it cannot be weakened with an environment
override.

Publication bounds are contract constants rather than environment settings:
100 records and 48 KiB per catalog batch, 128 KiB per authenticated HTTP body,
and 4,096 batches per release. The catalog runner leases work for 30 seconds,
processes at most 32 operations per cycle, and defaults to eight retries with a
500 ms through 30 second bounded backoff. Changing these limits is a reviewed
contract/code change, not an operator override.

The combined provider worker also validates its provider credential,
pseudonymization, scheduling, retention, and database-pool settings before
starting either promotion lane. A stable `*_INVALID` startup code is safe to
record; the rejected value and exception text are not.

## Organization and deployment binding gate

Before every first activation or deployment move:

1. A release operator compares `PACKSCOUT_PUBLIC_ORGANIZATION_ID`,
   `PACKSCOUT_CATALOG_DEPLOYMENT_KEY`, and
   `PACKSCOUT_CONVEX_PUBLICATION_BASE_URL` with the protected deployment
   inventory. Record only the approval reference and pass/fail outcome.
2. Confirm the organization exists in PostgreSQL and that no second organization
   is approved for that Convex deployment.
3. Start the worker. Its authenticated active-state bootstrap must prove either
   that Convex is empty or that PostgreSQL owns the exact active publication and
   terminal receipt digest. `unverified` bootstrap state is a launch blocker.
4. Confirm the protected operational health view has no unresolved
   `promotion_*` alert. Do not copy the organization or deployment identifier
   into the evidence bundle.

Never fix a binding failure by editing a lane row, changing a receipt digest, or
clearing Convex. Correct the deployment configuration and repeat bootstrap.

## Initial backfill and enablement

The first catalog is allowed only when all of these gates pass:

1. An approved, versioned public catalog configuration and governed public
   repack mappings exist at or before the target watermark.
2. Every enabled platform resolves to an active provider configuration revision.
3. Every enabled revision has a successful import that reached provider head.
4. Every causal derivation through the target is settled. Business-unavailable
   outcomes are valid; pending, claimed, or technical-failure outcomes are not.
5. The deterministic full rebuild passes public projection, origin, reference,
   record-count, byte-count, and hash checks.
6. The authenticated bootstrap reports an empty Convex deployment before the
   first activation, or an exact PostgreSQL-owned active receipt on restart.

`INITIAL_BACKFILL_INCOMPLETE`, `INITIAL_PROVIDER_DELAYED`,
`PUBLIC_CONFIGURATION_UNAPPROVED`, and technical settlement alerts are blockers,
not retry bypasses. After the first complete activation, a delayed provider may
retain its last settled public values. The release must then report a nonzero
`delayedVendorCount`; it must not mix unsettled rows into the release.

## Normal health and alert evidence

The protected PostgreSQL alert ledger is authoritative for operator alerts.
Console logs are diagnostic only.

Alert and recovery keys are isolated by the server-derived deployment digest
and lane. A recovery in one deployment must not resolve, suppress, or count an
alert for another deployment in the same organization.

| Condition | Durable kind | Required safe evidence | Recovery condition |
|---|---|---|---|
| Ready catalog or Heat target remains unconfirmed for at least one minute | `promotion_activation_delayed` | lane, target and confirmed watermarks, duration | Lane confirms through the target and has no technical settlement block. |
| A technical derivation exists beyond the contiguous settled watermark | `promotion_settlement_blocked` | lane, source-head and settled watermarks, count | Technical block is resolved and the lane confirms the resulting settled target. |
| Terminal transport, contract, assembly, or reconciliation failure | `promotion_failed` | lane, terminal/reconciliation condition, attempt UUID, target and confirmed watermarks, stable failure code | A later exact publication or unchanged refresh confirms the target with no block. |
| Any of the preceding conditions clears, including after process restart | `promotion_recovered` | lane, target and confirmed watermarks | Resolves every active alert sharing that lane recovery key. |

Repeated health polls do not create repeated in-process condition events. On
restart, the service checks the durable unresolved-alert count: a healthy lane
emits recovery only when PostgreSQL proves recovery is pending. No standalone
healthy-start event is written.

The lane evaluator cannot write a durable alert while its worker process is
down. Production launch therefore requires an independent deployment-supervisor
or external monitor that alerts on worker liveness and on a Heat confirmed frame
that is not advancing, early enough to respond before the 15-minute frame expiry.
The external monitor covers process-down failures; the durable lane alerts above
cover process-alive publication and reconciliation failures. Record both monitor
checks as production evidence. No application health endpoint is required by
this runbook.

Catalog health logs may include settled/requested/activated watermarks, active
attempt state and age, retry time, activation/unchanged times, operation count,
failure code, and delayed-vendor count. Heat health may include its frame,
requested, and confirmed sequences; active attempt state/age; retry and last
activation/unchanged times; signal-set reuse; acknowledged operation count;
failure code; and normalized-retention batch/deletion/cap state. They must not
include an organization, deployment key, provider identity, raw observation,
credential, signing material, actor, run, or quarantine detail.

## Retry, reconciliation, restart, and shutdown

- Leave `sent` operations in the durable ledger after timeout, disconnect,
  malformed response, invalid response authentication, or shutdown. The next
  cycle asks authenticated operation status first and resends the exact stored
  bytes only when status proves the operation absent.
- Do not construct replacement JSON, skip an ordinal, lower a watermark, or
  manually acknowledge an operation. Operation ID, canonical body, request
  digest, receipt body, and receipt digest are immutable recovery evidence.
- A stale claim token cannot acknowledge, retry, or complete an attempt. Allow
  its lease to expire so another worker can reclaim it.
- On `SIGINT` or `SIGTERM`, the worker aborts the in-flight HTTP request and
  stops both loops before closing PostgreSQL. Supervisors should allow the
  normal graceful-stop window. A forced kill is recoverable because dispatch
  was recorded before the network send.
- After restart, require bootstrap verification and a status-first resolution of
  every ambiguous operation before declaring the lane recovered.

If reconciliation fails terminally, keep the prior pointer active, preserve the
attempt and receipt evidence, and investigate the stable code. Never repair a
hash/count mismatch by mutating staged Convex documents.

## Key rotation

Signing rotation uses an overlap; it never changes an existing operation body.

1. Generate a new 32 through 256-byte secret and a new versioned key ID in the
   secret manager.
2. Add the new key ID and canonical-base64 value to the strict
   `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` JSON map while retaining the old
   entry. Deploy Convex first.
3. Verify the old worker can still authenticate, then switch
   `PACKSCOUT_CONVEX_PUBLICATION_KEY_ID` and
   `PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64` together and restart safely.
4. Observe a signed status request and one terminal catalog or Heat receipt with
   the new key. Evidence records the key ID and result, never the map or secret.
5. Keep both entries through all in-flight retries and at least the five-minute
   request window plus the ten-minute nonce-retention window. Remove the old
   entry only after the ledger has no operation that can retry with it.

An unknown-key alert during overlap means deployment ordering is wrong. Restore
the old worker key or re-add the old Convex map entry; do not disable signing.

## Rollback, clear, and settlement unblock authority

- A release operator may submit a signed rollback only to the retained previous
  complete release and must provide the exact expected active release. Heat
  becomes available only when a frame aligned to the resulting active catalog
  exists.
- Clearing the catalog is destructive emergency authority. It requires incident
  commander approval, an empty rollback target, the explicit
  `clear_catalog_v1` authorization in the signed request, and temporary
  `PACKSCOUT_DATA_RELEASE_CLEAR_ENABLED=1`. Remove the flag and verify the empty
  pointer immediately after the receipt.
- Only the owning derivation processor/data operator may retry or record a new
  terminal business outcome for a technical derivation. A release operator must
  not advance `settled_public_watermarks` or rewrite an obligation.
- A blocked manifest is corrected in approved PostgreSQL configuration or
  canonical data, producing a new causal sequence. It is never unblocked by
  editing Convex staging rows.

Record the approval reference, signed operation ID, before/after public pointer,
and terminal receipt digest. Do not record actor identity, tenant, key material,
or source data in the portable evidence bundle.

## Retention

Catalog retention protects the active and previous catalog releases and every
catalog release referenced by active/previous Heat. Complete releases become
age-eligible after seven days; at most three additional non-pointer complete
releases are retained. Abandoned staging and failed releases become eligible
after 24 hours. Authenticated retention deletes at most 100 documents per
mutation and returns `continuation_required` when more work remains.

Production Heat retention protects active/previous frames, their immutable
signal sets/signals, and the finalize/refresh proof receipts. Retired frames,
unreferenced signal sets/signals, completed publication/batch metadata, and
unprotected operations age out after seven days. Abandoned staging or failed
Heat publications become eligible at the frame expiry. The hourly cron and
authenticated `/internal/repack-heat/v1/retain` path delete bounded batches of
90 documents and continue when required. A frame also has an exact 15-minute
ID-and-expiry-bound scheduled callback; a stale callback cannot expire a newer
frame.

Normalized PostgreSQL Heat observations and dispositions retain exactly seven
days and are deleted by the independent bounded worker cycle. Promotion attempts,
exact request bytes, and terminal receipt proofs are durable launch/recovery
evidence and are not manually purged under this runbook.

If any protected pointer target or proof receipt is missing, retention must fail
closed with `PUBLICATION_RETENTION_UNSAFE`. Repair or rollback the pointer under
incident authority; never delete around it.

## Legacy prelaunch Heat cutover

There is intentionally no dual read, optional-field compatibility path, or
authenticated reset/purge endpoint. An environment that ran snapshot-owned
legacy/mock Heat must complete a separately approved, environment-scoped cleanup
or one-time migration before the new schema push:

1. Prove the environment contains no observed production Heat rows. If it does,
   stop and design a reviewed one-time migration instead of deleting data.
2. Back up and account for legacy `repackHeatState`, `repackHeatSnapshots`, and
   `repackHeatSignals` documents.
3. Clear or migrate those three legacy tables with an explicitly environment-
   scoped utility owned by the Convex operator. The new
   `repackHeatSignalSets`, `repackHeatPublications`, `repackHeatBatches`, and
   `repackHeatOperations` tables did not exist in the legacy deployment.
4. Push the new schema, confirm the Heat pointer is empty, then let the production
   Heat lane publish a full observed frame aligned to the active catalog.
5. Read back the frame, signal count/hash, active release alignment, and expiry
   before enabling public Heat.

No generic cleanup command is committed because the action is destructive and
deployment-specific. The absence of an approved environment-scoped utility and
backup is a launch blocker, not permission to use the local mock publisher.

## Evidence levels and readiness matrix

Evidence must be labeled. Local fake evidence proves deterministic code paths;
it is not evidence of live credentials, network behavior, production volume, or
the one-minute service target.

| Level | What it can prove | What it cannot prove |
|---|---|---|
| Local automated | Contract validation, tenant scoping, deterministic hashes, durable retries, fake lost acknowledgements, pointer/retention invariants, Heat alignment/expiry | Live auth configuration, production latency, real provider completeness, hosted Convex limits |
| Preproduction live | Secret-manager wiring, real HTTPS/auth/status reconciliation, deployment binding, representative-volume timing, rollback and retention rehearsal | Production provider state and launch-day p95 |
| Production observation | Actual backfill readiness, active pointer/receipt, delayed-vendor behavior, Heat cadence/expiry, p95 latency over the declared sample window | Nothing beyond the recorded window/volume |

Run these local gates from a clean integrated branch:

```bash
npm run test:contracts
npm run test:database
npm run test:services
npm run test:worker
npm run test:convex
npm run check:prisma
npm run verify:framework
```

The focused local volume gate is reproducible with:

```bash
node --import tsx --test packages/services/src/catalog-release-volume.test.ts
```

It constructs the protocol maximum of 8,000 repacks and 8,000 bounded chase
relations, prepares the operation bodies that are signed at dispatch, asserts the 100-record,
48-KiB, 128-KiB, and 4,096-batch limits, and requires local planning and
preparation to finish within one minute. Its reported duration is local CPU
evidence only. It excludes PostgreSQL snapshot loading, scheduling, HTTPS,
hosted Convex execution, and confirmation, so it cannot prove settled-to-
confirmed p95.

The local mock flow is explicitly fake:

```bash
npm run dev:frontend:mock-heat:local
```

Do not copy mock release IDs, simulated Heat, loopback timing, or local secrets
into a live readiness claim.

| Launch scenario | Required sanitized evidence | Gate |
|---|---|---|
| Startup/configuration | Stable success or `*_INVALID` code for every required setting; exact migration readiness | Must pass in preproduction and production |
| Initial activation | Backfill/config/mapping approval outcome, settled/requested/confirmed watermarks, content hash/counts, attempt UUID, terminal receipt digest | Must pass live before public enablement |
| Full versus incremental rebuild | Equal catalog public hash and counts at the same settled watermark | Must pass locally and in preproduction |
| Restart, stale lease, replay, lost acknowledgement | One terminal outcome, no duplicate/regressed pointer, exact status-first receipt | Must pass locally and in preproduction |
| Auth, contract, hash, count, and manifest failures | Prior pointer remains readable plus durable safe failure/recovery alerts | Must pass locally; auth also in preproduction |
| Rollback and emergency clear | Approval reference, before/after pointer, signed receipt digest, protected retention proof | Rehearse rollback in preproduction; clear only under incident authority |
| Key rotation | Overlap deployment, new-key status and terminal receipt, old-key retirement time | Must pass in preproduction before live rotation |
| Catalog retention | Active/previous/Heat targets preserved; bounded continuation completes | Must pass locally and in preproduction |
| Heat alignment and expiry | Frame catalog ID, sequence, aggregate hash/count, calculation/expiry times, unavailable result after 15 minutes | Must pass locally and in preproduction |
| Representative volume | Volume, batch counts/bytes, settled-to-confirmed samples, p50/p95/max, error count | Preproduction required; repeat in production |

For the catalog one-minute goal, measure from `settled_at` to the matching
activated or unchanged confirmation time. For Heat, measure consecutive exact
minute boundaries to confirmed frame time. Record sample count, observation
window, volume, p50, p95, maximum, and failures. Do not state that p95 is met
until live or representative preproduction measurements prove it; local unit
test duration is not publication latency.

The portable evidence bundle may contain only fixture/version labels, lane,
watermarks/sequences, public content and aggregate hashes/counts, attempt UUIDs,
terminal receipt digests, pointer results, safe failure codes, timing samples,
and commands. Remove database URLs, organization/deployment identifiers,
provider names, raw payloads/observations, actors, run/quarantine IDs, headers,
nonces, and all key material before review.
