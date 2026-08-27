# DataForrest Task 010 local bootstrap and backfill runbook

**Scope:** one new, named, empty PostgreSQL database on the local loopback
interface. This procedure never uses the disposable embedded-admin database and
never deletes or adopts existing application data. The separate normal-development
reset note below describes a different database and is not a Task 010 step.

For routine source operation after bootstrap, use the
[ingestion pipeline operator guide](ingestion-pipelines/README.md). This runbook
owns only the guarded Task010 target, configuration, first backfill, and final
reconciliation procedure.

DataForrest has one production identity: source type
`dataforrest-events-v1`, adapter `dataforrest-events-adapter-v2`, normalized
observation `packscout.provider-observation.v1`, and mapper revision `1`.
Historical adapter, observation, and mapper revisions are not upgrade inputs.
Any local database that contains a v2 or v3 pin must be rebuilt before this
procedure is used.

For the normal development database, stop admin and worker processes and run
`npm run db:reset:local`. That workflow refuses any non-loopback PostgreSQL
target, drops and reapplies every migration, and invokes the canonical local
seed. It is intentionally a full relational reset: organizations, operators,
sessions, audits, source configuration, imports, canonical data, and promotion
state are removed. The seed restores only the minimum local organization and
stable provider roots, so an administrator and the encrypted DataForrest
connection must be provisioned again before import.

Do not use `db:reset:local` as a shortcut for this dedicated Task 010 target:
its standard seed makes the target non-empty and therefore invalidates the
Task 010 bootstrap proof. A contaminated Task 010 target must be stopped,
discarded, recreated as the same named empty local database, and taken through
inspect, migrate, and bootstrap below with a new one-time administrator
password. Cursor reset, adapter upgrade, source replacement, and selective
table deletion are not clean-slate substitutes.

**Historical Task 010 admission state (2026-08-22): BLOCKED.** That isolated
bootstrap procedure used an 8,759,332,238,475-byte maximum-throughput stress
ceiling and an 80%-used volume fence. The stress ceiling is not the operational
estimate for the current `packscout_dev` import. For early local development,
use the normal ingestion guide's explicit free-space floor and the
[2026-08-24 live capacity observation](provider-source-live-capacity-observation-2026-08-24.md).
This runbook still must not be used to bypass the isolated Task 010 target's
own historical receipt checks.

## 1. Install and create the private configuration file

From the repository root:

```bash
npm ci
npm run init:provider-source-task010-environment:local
```

The initializer exclusively creates `.env.task010.local` with mode `0600`.
Every Task 010 command refuses a symlink, non-regular file, wrong owner, or any
group/world permission. Never `source` this file: dotenv syntax is not shell
syntax, and sourcing could disclose or reinterpret credentials.

Edit the file directly with a local editor. Replace every `REPLACE_...` value.
Obtain the PostgreSQL password and the one-time administrator password from the
password manager. The initializer generates the session secret, actor key,
credential keys, IDs, and key version. Do not print, copy to chat, or commit the
file. Keep these fixed values unchanged after bootstrap so admin and worker use
the same database and encryption revision.

The database must be named `packscout_dataforest_task010`. Create only that
database through the local PostgreSQL account; the normal password prompt keeps
the password out of argv and shell history:

```bash
createdb --host=127.0.0.1 --port=5432 --username=packscout packscout_dataforest_task010
```

Set `PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH` to the PostgreSQL data directory or
one of its canonical ancestors on the same device. The command itself queries
`current_setting('data_directory')`; an unrelated large volume cannot satisfy
the gate.

## 2. Bind, admit, migrate, and bootstrap the exact target

```bash
npm run inspect:provider-source-task010-target:local
```

The safe JSON receipt contains no URL or secret. Copy only the returned
`target.fingerprint` into `PACKSCOUT_TASK010_DATABASE_IDENTITY` in the private
file and rerun the command. It binds the database name/OID, PostgreSQL cluster
system identifier, loopback address, and port. A server patch-version change
does not change the fingerprint.

If the capacity decision is rejected, stop here. Do not migrate, bootstrap,
start admin, or start either supervisor phase. On an approved target only:

```bash
npm run migrate:provider-source-task010-target:local
npm run db:prisma:validate
npm run test:prisma-schema
npm run test:prisma-lifecycle --workspace=@packscout/database
npm run test:prisma-setup --workspace=@packscout/database
npm run bootstrap:provider-source-task010-target:local
```

The guarded migration rechecks the fingerprint, empty relation set, actual
backing volume, and capacity immediately before invoking Prisma without a URL in
argv. Bootstrap takes a serializable lock, rejects any pre-existing application
row, creates one organization, the first administrator, and these four stable
provider roots: Courtyard, Collector Crypt, Phygitals, and ClutchPacks. Its
audit receipt binds target identity, migration checksum, capacity artifact,
data directory, and device.

After the first successful bootstrap, permanently remove the entire
`PACKSCOUT_TASK010_ADMIN_PASSWORD` line from `.env.task010.local`, then clear
both one-time plaintext variables from the calling shell:

```bash
unset PACKSCOUT_TASK010_ADMIN_PASSWORD PACKSCOUT_DATA_API_TOKEN
npm run bootstrap:provider-source-task010-target:local
```

The second command must report `already_present`; it verifies the exact audit
receipt and roots without needing the removed password. A defined variable,
even an empty one, is rejected by long-lived starts.

## 3. Start admin and configure without permitting page reads

Terminal A:

```bash
unset PACKSCOUT_TASK010_ADMIN_PASSWORD PACKSCOUT_DATA_API_TOKEN
npm run start:provider-source-task010-admin:local
```

Open `http://127.0.0.1:5101/login`. Health is
`http://127.0.0.1:5101/api/health`; source configuration is
`http://127.0.0.1:5101/source-configuration`; operations are
`http://127.0.0.1:5101/operations`. The wrapper pins loopback origins, empty
trusted proxies, and fixed session bounds before loading admin.

In Source configuration:

1. Create the single **DataForrest connection** named for this local run with
   endpoint `https://198.204.245.26.sslip.io/v1/events` and request limit `2`.
   Paste the authorized bearer only into **Bearer credential**. Do not put it in
   `.env.task010.local`, a command, screenshot, or note; clear the clipboard.
2. Select **Test** for the connection. In Terminal B run the configuration-only
   supervisor shown below. Wait for the test result, reload Source
   configuration, then select **Activate revision**.
3. For each stable provider root, save one inactive source with its matching
   provider/mapper choice, the shared profile, and interval `60`. Select
   **Test**, wait for success, reload Source configuration, then **Activate
   paused**.

Source Configuration does not poll completed test jobs. Reload it after each
connection, source, or recovery test before judging the result or activating a
revision.

Terminal B:

```bash
unset PACKSCOUT_TASK010_ADMIN_PASSWORD PACKSCOUT_DATA_API_TOKEN
npm run start:provider-source-task010-configuration:local
```

This phase can execute connection/source tests but injects a hard
`TASK010_CONFIGURATION_PHASE` denial for page execution. Stop it with `Ctrl-C`
after all four sources are tested and paused. It cannot silently become a
backfill worker when a source is activated or resumed.

## 4. Real backfill procedure — only after an approved capacity receipt

Do not execute this section while the scorecard is BLOCKED. Start only the
singleton source supervisor (never `start-admin-embedded` or the aggregate
worker):

```bash
unset PACKSCOUT_TASK010_ADMIN_PASSWORD PACKSCOUT_DATA_API_TOKEN
npm run start:provider-source-task010-backfill:local
```

The empty-target inspect command belongs only before migration. It intentionally
rejects this migrated, bootstrapped database. Immediately before opening the
worker, the backfill starter itself rechecks the exact database identity,
migrated schema, current capacity with application relations present, bootstrap
receipt, and four-source backfill topology. Any failed recheck stops before the
supervisor can claim work.

The backfill start requires exactly one active tested profile at cap 2. Every
connection revision must use DataForrest adapter v1, and exactly four tested,
paused-or-active sources must have only the adapter-v1, observation-v1,
mapper-v1 tuple across every revision. Any v2, v3, unknown, or mixed tuple
fails closed before the supervisor starts. In Operations, select **Resume** for
all four sources; Resume makes each lane due immediately.
The dedicated Task 010 runner forces `PACKSCOUT_SOURCE_EXECUTION_SLOTS=1` for
the current v1 8 MiB memory boundary, even if its private environment file
omits or attempts to change that value. Verify each individual cursor remains
sequential and the four source lanes continue taking turns without starvation.

After multiple sources have committed pages, stop Terminal B with `Ctrl-C`.
Restart the same backfill command and verify each source resumes from its own
cursor. During the run:

- Select **Pause** for one provider and confirm it stops after its current page
  while the other three continue; then **Resume**.
- Select **Run now** while that provider is pending/running and confirm it
  coalesces rather than creating duplicate work.
- In Source configuration, revise one provider interval, select **Save timing**,
  and confirm other sources' next-due times/cursors do not change.
- Open each provider from Operations and inspect its diagnostic feed. Shared
  connection events must be labeled; source events must remain provider-local.
- Exercise one retry or provider-local failure and recovery without pausing an
  independent source.
- After every provider reaches head, observe at least one due window and verify
  no early upstream poll.

Stop safely with `Ctrl-C`. Never reset a cursor or delete data as part of
this runbook.

## 5. Reconcile and verify

```bash
mkdir -p .tmp
npm run reconcile:provider-source-task010:local > .tmp/task010-reconciliation.json
node --test scripts/local/provider-source-task010-safety.test.mjs
npm run test:contracts
npm run test:database
npm run test:services
npm run test:worker
npm run test:admin
npm run test:frontend
npm run test:tooling
npm run lint
npm run typecheck
npm run check:framework
npm run verify:framework
```

The reconciliation report uses durable request-attempt `response_bytes`, not
expired protected bodies. It reports all disposition, canonical, EV,
availability, quarantine, throughput, latency, retry, and relation/index-size
evidence. Its overall status remains `BLOCKED` unless the required live
operational and resource proof is present; null evidence can never certify Task
010 as PASS. Keep generated reports under ignored `.tmp/` and never include raw
provider values or secrets.
