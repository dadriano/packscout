# DataForrest Task 010 local bootstrap and backfill runbook

**Scope:** one new, named, empty PostgreSQL database on the local loopback
interface. This procedure never uses the disposable embedded-admin database and
never deletes or adopts existing application data.

**Current admission state (2026-08-21): BLOCKED.** The measured host has
30,338,781,184 available bytes. Task 010 requires 8,757,364,735,856 available
bytes and an independently enforced less-than-80%-used filesystem. Do not run a
real backfill on this host.

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
   supervisor shown below. Wait for the test result, then select **Activate
   revision**.
3. For each stable provider root, save one inactive source with its matching
   provider/mapper choice, the shared profile, and interval `60`. Select
   **Test**, wait for success, then **Activate paused**.

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

Do not execute this section while the scorecard is BLOCKED. Re-run the guarded
inspect immediately before the start. Then start only the singleton source
supervisor (never `start-admin-embedded` or the aggregate worker):

```bash
npm run inspect:provider-source-task010-target:local
unset PACKSCOUT_TASK010_ADMIN_PASSWORD PACKSCOUT_DATA_API_TOKEN
npm run start:provider-source-task010-backfill:local
```

The backfill start requires exactly one active tested profile at cap 2 and
exactly four tested, fully pinned paused-or-active sources. In Operations,
select **Resume** and **Run now** for all four sources. Verify two provider lanes
overlap while each individual checkpoint remains sequential.

After multiple sources have committed pages, stop Terminal B with `Ctrl-C`.
Restart the same backfill command and verify each source resumes from its own
checkpoint. During the run:

- Select **Pause** for one provider and confirm it stops after its current page
  while the other three continue; then **Resume**.
- Select **Run now** while that provider is pending/running and confirm it
  coalesces rather than creating duplicate work.
- In Source configuration, revise one provider interval, select **Save timing**,
  and confirm other sources' next-due times/checkpoints do not change.
- Open each provider from Operations and inspect its diagnostic feed. Shared
  connection events must be labeled; source events must remain provider-local.
- Exercise one retry or provider-local failure and recovery without pausing an
  independent source.
- After every provider reaches head, observe at least one due window and verify
  no early upstream poll.

Stop safely with `Ctrl-C`. Never reset a checkpoint or delete data as part of
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
