# Ingestion pipeline operator guide

This guide covers the provider-source ingestion pipeline after a PostgreSQL
target has been provisioned. It explains how to configure sources, run one
supervisor, monitor progress, stop and restart safely, and respond to common
failure states without losing a committed cursor.

The current launch source is DataForrest, but the operating model is
source-neutral: one shared connection feeds four independent provider lanes for
Courtyard, Collector Crypt, Phygitals, and ClutchPacks.

For a first full-history backfill, do not use this guide by itself. Follow the
[guarded Task010 bootstrap and backfill runbook](../dataforest-source-integration-task010-local-runbook.md).
It binds the exact database and backing volume, proves capacity, bootstraps the
four stable provider roots, and prevents page reads during configuration.

## Safety rules

- Run exactly one source-supervisor owner for a database. Do not run the
  source-only supervisor beside the full worker, because the full worker already
  contains the same singleton supervisor.
- Apply database migrations as a separate deployment step. Runtime startup does
  not migrate the schema. Use the [database provisioning workflow](../database-provisioning.md).
- Deliver the upstream bearer only through **Source Configuration** in the
  admin. It is encrypted at rest. Never put it in a tracked file, command,
  screenshot, log, diagnostic, or browser-visible variable.
- Stop with `Ctrl-C` or `SIGTERM`. A graceful stop drains admitted work and
  closes the database client. Never clear a lease or edit a cursor directly.
- A retry, restart, pause, credential recovery, or worker takeover resumes from
  the last atomically committed cursor. Do not reset a cursor as a
  routine recovery action.
- A full-history run requires the guarded capacity approval from the Task010
  runbook. Production uses the ongoing 80% disk fence as an emergency stop,
  not as approval to begin a backfill. A shared local development volume may
  instead use an explicit free-space reserve as described below.

## What runs where

```text
Admin console
  Source Configuration ---- create, test, activate, rotate, pause, disable
  Pipeline Status ---------- operate and monitor four provider lanes
           |
           v
PostgreSQL control plane --- schedules, runs, leases, cursors, diagnostics
           |
           v
One source supervisor ------ fair execution slots + shared connection permits
           |
           v
Source adapter ------------ capture, validate, normalize, classify
           |
           v
Atomic importer ----------- evidence + canonical data + EV work + cursor
```

## Interpreting the storage estimate

Do not use the 8.76 TB maximum-throughput scenario as a prediction for a local
backfill. It assumes four new 250-record pages every minute for 365 days. The
first live `packscout_dev` sample instead measured 7,024 marginal bytes per
committed record and 8,123 bytes per record including fixed database overhead.
At the dated 14,526,877-record provider baseline, that is a provisional
136.1–157.3 GB planning range with 25% free headroom, not 8.76 TB. See the
[live capacity observation](../provider-source-live-capacity-observation-2026-08-24.md)
for the samples, assumptions, and remeasurement points.

The local runtime enforces the configured free-space floor on actual volume
availability after in-flight reserves. Production continues to enforce the
separate 80%-used emergency fence.

The four provider lanes share connection health and the configured request
limit, but each lane owns its source lifecycle, schedule, run, cursor,
freshness, quality, quarantine, and diagnostics. A provider-local failure must
not stop a healthy sibling.

Ingestion reaching provider head means PostgreSQL is current through the saved
source cursor. It does not publish a release to Convex or make the data live
in the public catalog. That downstream boundary has its own
[PostgreSQL-to-Convex promotion runbook](../postgres-convex-promotion-runbook.md).

### How the next poll is stored

PostgreSQL is authoritative for each provider source's resume position. The
`provider_source_cursors` table has one row per source instance:

- `cursor` is the nullable text value sent to the provider on the next poll;
  `NULL` means **Feed start**.
- `cursor_generation`, `cursor_codec_version`, and `cursor_fingerprint` record
  the source-owned interpretation and safe comparison metadata.
- `advanced_by_run_id`, `advanced_by_page_id`, and `updated_at` identify the
  committed page that last moved the cursor.

An atomic page commit stores the provider's returned cursor together with its
run/page provenance and advances the run's `current_cursor` plus
`next_page_number`. The next run initializes its `requested_cursor` and
`current_cursor` from that saved source cursor. Admin and browser responses
receive only `cursorFingerprint` and the **Saved cursor** label; the raw cursor
never crosses the server boundary.

## Prerequisites

Before starting admin or a supervisor, confirm all of the following:

1. PostgreSQL 16 or newer is migrated with the checked-in Prisma migrations.
2. The organization, administrator or data operator, and four stable provider
   roots already exist. Do not use the legacy **Data Providers / New** form to
   bootstrap provider-source ingestion.
3. Admin and worker use the same database, actor-pseudonym key, source-connection
   encryption key, and source-connection key version.
4. `PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH` names the real PostgreSQL data
   directory or an approved canonical ancestor on the same device.
5. The intended operator has the permissions required for the action.

The source-only supervisor reads these values from the root ignored `.env`:

| Variable                                  | Purpose                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `PACKSCOUT_DATABASE_URL`                  | PostgreSQL target used by admin and the supervisor.                                    |
| `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64`     | Stable 32-byte base64 key for safe operator and diagnostic correlation.                |
| `PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64`  | Distinct 32-byte base64 key that encrypts source-connection configuration.             |
| `PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION` | Positive integer identifying the active source-connection encryption key.              |
| `PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH`   | Absolute, non-root path whose filesystem holds PostgreSQL data.                        |
| `PACKSCOUT_SOURCE_DISK_RESERVE_GIB`       | Optional local-only free-space floor. Page reads stop before projected commits would leave this many GiB free. |
| `PACKSCOUT_WORKER_ID`                     | Optional stable process identity; a safe unique local value is generated when omitted. |

The admin also requires its normal session and provider configuration,
including `PACKSCOUT_SESSION_HASHING_SECRET` and
`PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64`. Keep all secret values in the
approved secret store or ignored local environment. Never prefix a secret with
`NEXT_PUBLIC_`.

### Permissions

| Permission                | Operator capabilities                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `providers:view`          | View configuration, pipeline status, runs, safe diagnostics, quarantine, workers, and alerts. |
| `imports:start`           | Run now, pause, and resume a provider source.                                                 |
| `imports:retry`           | Retry retained quarantined records.                                                           |
| `providers:manage`        | Create, test, and activate sources; revise timing; replace, disable, or reset a source.       |
| `provider_secrets:manage` | Additionally create, rotate, recover, or revoke connection credentials.                       |

## Start and stop the pipeline

For a normal local source-only session, use two terminals from the repository
root:

```bash
# Terminal A: admin at http://127.0.0.1:5101
npm run dev:admin

# Terminal B: ingestion only
npm run start:source-supervisor:local
```

Alternatively, `npm run start:worker:local` starts the full local worker,
including the same source supervisor and unrelated worker lanes. Choose one
worker command; never start both against the same database.

Use `npm run start:admin` and `npm run start:worker:production` only in a
reviewed self-hosted environment with production configuration supplied by its
secret store. Worker hosting and deployment remain environment-owned.

Stop an interactive worker with `Ctrl-C`. Wait for it to exit before restarting
or starting a different worker command. A clean restart needs no cursor or
lease repair:

```bash
npm run start:source-supervisor:local
```

If a process was killed, start one replacement and let the durable singleton
takeover reconcile expired work. Do not start several replacements, delete
runtime rows, or shorten leases manually.

## Configure a new pipeline

Open `http://127.0.0.1:5101/source-configuration`.

### 1. Configure the shared connection

1. Create one **DataForrest events** connection with the approved HTTPS endpoint,
   a descriptive name, the authorized bearer, and request limit `2`.
2. Start the supervisor so it can execute the queued connection test.
3. Select **Test** and wait for the latest exact revision to succeed.
4. Select **Activate revision**. A historical success is not sufficient after a
   newer pending or failed test.

The admin returns only a masked credential summary. The bearer is encrypted
with the source-connection key and is decrypted only by the worker for the exact
pinned revision.

Source Configuration does not poll completed test jobs. After the supervisor
finishes a connection, source, or recovery test, reload the page before judging
the result or selecting an activation action.

### 2. Configure the four sources

For each stable provider root:

1. Create a source using the server-supplied adapter, mapper, identity namespace,
   and record-ID scopes. Do not substitute a browser-selected mapper.
2. Bind it to the active shared connection and choose an interval from 60
   seconds through 24 hours.
3. Select **Test** and wait for both the latest connection test and latest source
   test to be current and successful.
4. Select **Activate paused**. This establishes the schedule without starting a
   page read.

Activation pins the exact source, adapter, normalized contract, mapper,
connection revision, schedule, and cursor generation. Changing those pins
requires an explicit tested revision or replacement.

### 3. Begin ingestion

Open `http://127.0.0.1:5101/operations` and select **Resume** for each intended
provider. Resume makes that source due immediately from its committed
cursor. **Run now** is an optional explicit manual trigger; selecting it
while work is already queued or running exercises the same coalescing boundary
but does not make a resumed source start sooner.

`Run now` coalesces with an existing queued or running run. Repeated clicks do
not create parallel work for one source.

## Daily operations

| Action           | Where                                   | Durable behavior                                                                                                                                                |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run now          | Pipeline Status or provider detail      | Creates one manual run or coalesces with existing work; starts from the committed cursor. It is unavailable while the source requires administrator action. |
| Pause            | Pipeline Status or provider detail      | Stops before the next page. An already captured page may commit first.                                                                                          |
| Resume           | Pipeline Status or provider detail      | Makes the source due immediately and returns it to its schedule from the committed cursor.                                                                  |
| Pause display    | Pipeline Status or provider detail      | Stops only the browser's five-second refresh. Ingestion continues.                                                                                              |
| Save timing      | Provider detail or Source Configuration | Creates a schedule revision between 60 seconds and 24 hours; does not reset the cursor.                                                                     |
| Retry quarantine | Quarantine                              | Reprocesses retained evidence independently; never rewinds the source cursor.                                                                                   |
| Disable source   | Source Configuration                    | Stops future work after the safe boundary while preserving history and cursor evidence.                                                                     |
| Replace source   | Source Configuration                    | Creates a separately tested source with its own cursor; identity compatibility is required.                                                                 |

At provider head, the next fetch waits for the greater of the configured source
interval and the adapter's source-neutral minimum delay. Repeated database polls
do not produce an early upstream request.

## Read the operational views

### Pipeline Status

`/operations` shows the shared connection, supervisor lease, disk-capacity
state, execution slots, request permits, and exactly four provider lanes. The
page refreshes every five seconds only while visible.

Each lane distinguishes:

- lifecycle and processing phase;
- continuation and explicit wait reason;
- next due time and last progress;
- pages plus catalog, pull, and trade counts;
- inserted, revised, duplicate, and quarantined dispositions;
- throughput, elapsed time, retry count, and lease age;
- source freshness and quality, separate from shared connection health.

The total history size remains **Total unknown** until a defensible
provider-specific total exists. Do not derive percent complete or ETA from the
page count alone.

### Provider detail and diagnostics

`/providers/:providerId` shows the exact source pins, safe cursor
fingerprint, run history, committed page summaries, and bounded diagnostic
history. Filter diagnostics by severity, phase, or run. **Load older** uses an
opaque keyset cursor; an expired-history gap is reported explicitly and never
reconstructed from raw payloads.

Connection-scoped events are labeled **Shared connection**. Source events are
labeled **Selected source**. Use the safe code, event time, run/test link, and
bounded counters when escalating an incident; do not request or paste raw
payloads or credentials.

### Supporting views

- `/runs` and `/runs/:runId` show queued, running, succeeded, incomplete, or
  failed runs and their page/disposition totals.
- `/quarantine` shows record-local failures and retained safe evidence.
- `/background-work` shows estimated-EV recomputation and retention work.
- `/workers` shows process presence and effective settings.
- `/alerts` shows durable machinery conditions such as no live worker, a
  stalled run, an overdue schedule, queue backlog, or missing retention.

## Interpret common states

| State                               | Meaning                                                                             | Operator response                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No live worker / Supervisor offline | No active singleton is renewing.                                                    | Start exactly one intended worker. Do not clear leases.                                  |
| Queued                              | Durable work exists but has not received capacity.                                  | Check supervisor presence, next due time, and connection/capacity state.                 |
| Running                             | One page or bounded test owns this source lane.                                     | Let it reach its atomic boundary before stopping or pausing.                             |
| Waiting for capacity                | Execution slots, connection permits, or disk admission are temporarily unavailable. | Inspect the shared capacity summary; repeated Run clicks do not help.                    |
| Reached head                        | The source completed history available now.                                         | Wait for the independently configured next-due time.                                     |
| Pause requested                     | A page was already in flight when Pause was selected.                               | Wait for the current page to commit or terminalize; no next page will start.             |
| Retrying                            | A transient source-local failure has a durable retry time.                          | Inspect the safe code and wait for the bounded retry unless intervention is requested.   |
| Waiting on connection recovery      | One shared connection episode blocks bound work.                                    | Recover the connection revision; do not reset four source cursors.                   |
| Action required                     | A source-local validation, mapping, or immutable-state problem cannot retry safely. | Inspect source diagnostics, correct the exact cause, then use the tested lifecycle path. |
| Stale display                       | Browser refresh is paused or failed.                                                | Refresh safe evidence; this does not itself mean ingestion stopped.                      |

## Recovery playbooks

### Shared connection failure

Authentication, endpoint, TLS, destination, or encrypted-configuration failure
opens one connection-scoped blocking episode. Bound sources keep their committed
cursors and wait on that episode.

1. Open **Source Configuration** and inspect the masked connection state and
   latest safe code.
2. Create the offered recovery credential revision against the exact blocked and
   latest revision.
3. Request the episode-correlated recovery test and wait for its current result.
4. Activate the tested recovery revision.
5. Confirm Pipeline Status clears the shared episode and queues at most one
   recovery run per eligible source from its committed cursor.

Do not reactivate an old successful test, fabricate an episode, or reset source
cursors. Normal credential rotation and blocking-episode recovery are
different operations.

### Source-local failure or quarantine

Open the provider detail and filter diagnostics to the failed run or phase. If
the failure is record-local, correct the mapper/configuration issue and retry the
retained quarantine entry. Accepted siblings and the page cursor stay
committed.

An active source in **Action required** cannot be recovered by repeatedly
requesting a manual run. An administrator must correct the underlying issue,
disable the source at its safe boundary, request a fresh source test, activate
the tested source in paused state, and then resume it from the committed
cursor. Use replacement only when the source contract itself must change.

Protected raw page bytes expire after seven days. Quarantined evidence and safe
processor diagnostics are retained for 30 days. Compact dispositions, hashes,
canonical history, cursor lineage, and request-attempt lineage remain
durable.

### Capacity blocked or probe failed

The supervisor probes the configured database volume before and after page
work. Production stops granting page reads before projected in-flight commits
cross the 80% used threshold. On a shared local development volume,
`PACKSCOUT_SOURCE_DISK_RESERVE_GIB` replaces that percentage with an explicit
amount that must remain free after every already-admitted page commit. This
local setting is not Task010 capacity approval and is rejected in production.

1. Verify `PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH` resolves to the actual database
   device and remains readable.
2. Check Pipeline Status for `CAPACITY_ABORT_THRESHOLD_REACHED`,
   `CAPACITY_DISK_RESERVE_REACHED`, or `CAPACITY_PROBE_FAILED`.
3. Resolve the filesystem or approved-capacity problem outside the application.
4. Let the normal cooldown expire; do not repeatedly create manual runs.

For read-only planning, run:

```bash
npm run preflight:provider-source-backfill:local -- \
  --database-path /absolute/path/on/the/database-volume
```

This preflight must pass before a full backfill, but Task010 additionally binds
the database identity, PostgreSQL data directory, artifact, and bootstrap
receipt. Follow its runbook for the real start.

### Worker crash or ownership loss

Start one replacement supervisor. It waits for the predecessor lease boundary,
reconciles nonterminal request attempts, recovers expired claims, and resumes
from durable state. If the new owner reports fenced or uncertain work, use the
linked diagnostics; do not force a second process or mutate runtime tables.

## Destructive and exceptional actions

- **Emergency revoke** is for a compromised credential revision. It requires
  explicit confirmation and fences work pinned to that revision. Use normal
  tested rotation for routine credential changes.
- **Disable** intentionally prevents future source work. It is not a temporary
  pause.
- **Replacement** starts a new source instance at **Feed start** and requires the
  same provider identity namespace and record-ID scopes. It never transfers an
  old cursor.
- **Reset cursor** is a last-resort replay operation. The source must be
  paused or disabled; review the preview, type its exact confirmation, and
  understand that the next resume starts at **Feed start**. Never reset to fix a
  transient fetch, mapping, capacity, or worker failure.
- Never update ingestion tables with ad hoc SQL, delete quarantine evidence, or
  clear supervisor/request leases manually.

## First full-history backfill

The general start commands above are not sufficient authorization for a first
live history import. Use the
[Task010 local runbook](../dataforest-source-integration-task010-local-runbook.md)
for its private environment file, target fingerprint, schema/bootstrap checks,
configuration-only phase, exact topology guard, capacity decision, controlled
restart proof, and final reconciliation.

Do not start the guarded backfill while its scorecard is `BLOCKED`, and do not
replace the committed capacity result with a hand-entered disk estimate. The
[capacity measurement artifact](../provider-source-capacity-measurement-v1.json)
is machine-readable and the guarded scripts recompute its decision against the
actual PostgreSQL device.

## Verification and handoff

After a code, schema, or operational configuration change:

```bash
npm run verify:framework
```

Before handing an active pipeline to another operator, record only safe facts:

- exact deployed commit and migration status;
- active worker identity and supervisor renewal time;
- connection/source revision IDs and current test states;
- each provider lifecycle, cursor fingerprint, next due time, and latest
  run ID;
- open connection episode, action-required safe code, retry time, quarantine
  count, and capacity state;
- whether the display is live or intentionally paused.

Never include the bearer, database URL, encryption keys, full cursor,
vendor cursor, raw response body, protected provider fields, or personal data in
an operator handoff.
