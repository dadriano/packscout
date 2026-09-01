# Local provider resident supervision

The integration operator owns this explicit local utility. It runs one reviewed
provider backfill to its committed source head, then uses the existing continuous
poller at the greater of central cadence and the source's 60-second minimum.
The existing head-only command remains the default. This is an explicit new
bootstrap capability, not a migration or compatibility alias.

## Pins and activation

Use the coherent reviewed checkout and preserve all seven original pins across
process restarts. Configuration, credentials and exact isolated database routes
remain central authority; no source-token or provider-DSN override is added.
No migration, cursor reset, automatic repair of unknown errors or EV publication occurs.
The existing checkpoint retry policy additionally admits only
`PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED`, a trusted query-expiry diagnosis
issued after the failed transaction callback settles. Generic `P2028`, uncertain
commit outcomes and `PROVIDER_IMPORT_EXECUTION_FAILED` remain permanent failures.

```bash
node --import tsx scripts/local/run-provider-continuous-poller.mts \
  --check-only --bootstrap-backfill \
  --organization-id ORGANIZATION_UUID --provider-id PROVIDER_UUID \
  --provider-key PROVIDER_KEY --config-id CONFIG_UUID \
  --initial-run-id REVIEWED_RUN_UUID --operation-id STABLE_OPERATION_UUID \
  --operator-id ACTIVE_ADMIN_UUID
```

Check-only resolves durable state and validates the disposition without claiming
the health port, launching a worker, queueing a run, calling the source or writing
any database row. For execution, replace `--check-only` with `--run` using the
same pins. The original run must already be eligible for the existing backfill
supervisor; a permanent database/execution failure requires separate reviewed
repair and scoped recovery. There is no automatic resume of paused/stopped work.

The resident holds the existing provider's loopback health port, 56432–56435,
across both phases. A competing resident is refused before source or queue work.
The listener reports `backfilling`, `waiting_owned_child`, `handoff`, normal
continuous states, or `blocked`; process liveness alone does not prove progress.

## Durable transition and recovery

At verified head, a serializable transaction locks the existing import lease,
run and runtime. It requires idle runtime, the same generation/checkpoint and
authority, latest exact head run, no active work/commands, and no owned lease.
It persists one immutable `local.provider_resident.handoff` audit receipt with
the original pins, authority digest, head run/hash, generation and deterministic
continuous-operation ID. No raw cursor or credentials enter this receipt.

After a crash, the receipt selects the same initial continuous pins even when
later poll cycles exist. A missing receipt repeats head verification; an existing
receipt never creates a second continuous operation. The established continuous
cycle receipts and command/lease fencing then own all later work.

If a child survives its parent, a live import lease may be observed. Only an exact
execution-claim receipt with matching operation, operator, owner, fence, authority
and recovery lineage permits bounded read-only waiting. It never grants lease
takeover. After ordinary expiry, the existing fenced recovery remains the only
execution path. If the child committed head before dying and left its lease,
the exact audited expired lease is acquired/released normally without creating
a new run; head/controls/active work are revalidated under the lease lock.
Foreign/mismatched ownership is never adopted.

A running run that already committed head can recover only with matching
database-validated head/reconciliation proof. A zero-page recovery child follows
its exact inherited head lineage without copying pages or inventing counters;
it is a completed head only after its validated reconciliation receipt completes.
Headed terminal failures still require diagnosis and are not fresh source retries.

Pause remains under operator control; stop or a directly signalled child ends
the resident. Permanent or unknown write/execution failures latch `blocked`
without future queue/source work. Known provider-read connection failures can
retry bounded observations; they cannot clear a blocked latch or retry writes.
Resident and nested backfill database operations drain a timed-out gateway
callback before any next operation or client close. Deadline/abort guards refuse
later write stages; an already-issued database statement must settle normally.

## launchd deployment

`createProviderLaunchdPlan` in `scripts/local/provider-launchd-plan.mts` generates
a pure plan for one provider. It performs no installation, file writes, process
changes or database/source calls. The integration operator must verify the exact
checkout, Node executable, private log directory and loaded-job ownership before
installing the returned plist with mode 0600. Do not replace a foreign loaded
job, delete its files, kill arbitrary port owners, or run generic `restart.sh`.

The plan uses `com.packscout.provider-import.PROVIDER_KEY`, direct Node/tsx argv,
stable pins, a secret-free environment, `RunAtLoad`, a 30-second restart throttle,
and `KeepAlive.SuccessfulExit=false`. The 60-second shutdown allowance permits
bounded reads to settle. Use launchd bootout for a deliberate unload.

The explicit `--launchd` execution flag makes caught startup/configuration errors
emit a sanitized blocked result and exit successfully, avoiding blind restart
loops. A positively classified connection failure during central startup or the
initial read-only authority check instead exits 75 for throttled launchd retry,
so database startup ordering does not permanently stop an import. Credentials,
permissions, unknown database errors and writes do not gain that capability.
SIGTERM/SIGINT and operator stop also exit successfully. Unexpected process
death remains eligible for launchd restart. A job that stops due to a caught
permanent/unknown startup error needs maintenance diagnosis and explicit restart;
missing health must not be reported as a healthy feed. Local launch agents also
depend on the Mac being awake and the user session existing.

## Acceptance map

| Behavior | Coverage |
| --- | --- |
| Backfill reaches exact head, persists once, and restarts into unchanged continuous pins | `provider-resident-handoff.test.mjs`, `provider-resident-policy.test.mjs` |
| Pause/stop, foreign work, changed authority/checkpoint/head/lease refuse handoff | `provider-resident-handoff.test.mjs`, `provider-resident-policy.test.mjs` |
| Live surviving child waits only with exact receipt/fence/lineage; no takeover or implicit resume | `provider-resident-handoff.test.mjs`, `provider-resident-policy.test.mjs` |
| Running committed head and zero-page recovery inherit validated head/reconciliation proof without fabricated pages | `provider-resident-running-head.test.mjs` |
| Unknown/permanent writes latch; read outage cannot clear latch or overlap pending reads | `provider-resident-policy.test.mjs`, existing `provider-continuous-read.test.mjs` |
| Selective launchd crash restart, stable argv, no secrets, controlled startup exits | `provider-launchd-plan.test.mjs` |
| Known startup connection retries only, safe getter/proxy-resistant error codes | `provider-resident-errors.test.mjs` |
| Gateway timeout/rejection drains pending operation; deadline prevents later write stages | `provider-resident-operation.test.mjs` |
| One port owner and existing queue/crash-gap fencing | Existing `provider-continuous-policy.test.mjs`, `provider-continuous-persistence.test.mjs` |
| Live host job installation/restart and provider checkpoint advancement | Manual gap: integration operator verifies exact installed job/PID/health and durable counters; synthetic tests do not claim live success |

Run focused resident/launchd/continuous/backfill tests and strict TypeScript checks,
then `npm run verify:framework` on the assembled checkout before deployment.
Remove this local utility when a reviewed provider-local scheduler provides the
same durable handoff, ownership, operator-control and checkpoint guarantees.
