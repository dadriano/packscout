# Local provider backfill supervisor

This is an explicit one-provider local operation. It never provisions, changes configuration,
resets a cursor, or schedules future head polls. All four installed isolated providers,
including Clutchpacks, are eligible only after explicit scoped activation. Run only after the exact provider/configuration/run
checkpoint has been reviewed. `--initial-run-id` accepts an existing terminal transient failure
or the exact queued run produced by a reviewed profile handoff. Do not run another worker for
the same provider concurrently. Independent provider processes may run in parallel.

Read-only preflight (replace each uppercase placeholder with a reviewed UUID/key):

```sh
node --import tsx scripts/local/run-provider-backfill-supervisor.mts --check-only \
  --organization-id ORGANIZATION_UUID --provider-id PROVIDER_UUID \
  --provider-key PROVIDER_KEY --config-id CONFIG_UUID --initial-run-id RUN_UUID \
  --operation-id OPERATION_UUID --operator-id ADMIN_OPERATOR_UUID
```

For execution, use the same arguments with `--run` instead of `--check-only`. Keep the same
operation ID, initial run ID, and config ID on every process restart. Use an OS-detached process
with a private log directory for a long backfill; tool sessions are not durable process hosts.
Only root/operator-owned live execution is authorized by the implementation task.

The environment supplies the central DSN (`127.0.0.1:55431/packscout`) and central credential
encryption key. Provider routes and source credentials come exclusively from central authority.
Provider DSNs/source-token environment variables are ignored and not forwarded to the child.
Lane-supervisor configuration is rejected, including an empty variable. Provider routing is
pinned to Courtyard 55433, Collector Crypt 55434, or Phygitals 55435 and its exact database name.

Terminal timeout, network interruption, rate limit, and server failure retain the failed run,
persist retry intent and counters, resume through the command repository, and queue a new run
from the identical saved cursor. Equal-jitter exponential delay starts at 5–10 seconds and caps
at 150–300 seconds; prolonged no-progress alerts do not exhaust the retry policy. A fully
committed 50,000-page limit with a validated advancing `more` checkpoint is a separate bounded
continuation. Other failure codes, authority drift, and checkpoint drift stop with nonzero exit.

The additional `PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED` code is eligible
only because it identifies a trusted expired query after its transaction callback
has settled. Generic `P2028`, uncertain commit outcomes, invalid checkpoints and
`PROVIDER_IMPORT_EXECUTION_FAILED` are not retryable. The same checkpoint,
authority, generation, receipt and backoff requirements remain in force.

A known closed child with exact persisted launch/fence/generation/checkpoint evidence uses a
separate delayed execution-restart receipt, not a source-timeout code or a fresh command.
The existing runner's fenced `recoverActive` preserves interrupted-run history and resumes its
checkpoint. Foreign/live leases are never adopted. SIGTERM/SIGINT and runtime pause/stop exit
without automatic restart. A source-head result is success only without other active work.

Progress output contains identifiers, counters, stable codes, and retry times, never source
records, raw cursor values, connection strings, or credentials. Unknown failures are sanitized.
Local audit rows retain operation/retry/launch/restart provenance; no new schema is required.
