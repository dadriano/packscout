# Local operator-reviewed provider continuation

This utility queues one new manual run from an unchanged, fully committed failed
checkpoint. It does not call the source, start a worker, change request sizing,
modify configuration/schema, reset a cursor, edit the failed run, or change the
automatic retry allowlist. Permanent failures require an explicit operator request;
the receipt does not claim their original cause is known or repaired.

Only central `127.0.0.1:55431/packscout` and its centrally resolved isolated provider
database are accepted. Existing authority resolution verifies organization,
active admin membership, source credentials/configuration and destination. Never
use the old 5432 runtime. Credentials come from the existing central environment
loader; no provider DSN or source-token override is accepted.

Root/operator must first obtain a fresh read-only snapshot, ensure the target
writer is stopped, and create a private JSON review with this exact shape:

```json
{
  "pins": {
    "organizationId": "REVIEWED_UUID",
    "providerId": "REVIEWED_UUID",
    "providerKey": "phygitals",
    "configId": "REVIEWED_UUID",
    "initialRunId": "FAILED_PARENT_UUID",
    "operationId": "NEW_OPERATION_UUID",
    "operatorId": "ACTIVE_ADMIN_UUID"
  },
  "sourceCommit": "EXACT_CLEAN_VERIFIED_40_CHARACTER_COMMIT",
  "authorization": "operator_requested_one_time_continuation",
  "expectedGeneration": "15",
  "expectedImportFence": "9",
  "expectedCheckpointHash": "PRIVATE_REVIEWED_64_CHARACTER_DIGEST",
  "expectedFailureCode": "PROVIDER_IMPORT_EXECUTION_FAILED",
  "expectedFinishedAt": "2026-08-31T00:08:17.949Z",
  "expectedPageCount": 10272
}
```

The example counters are historical, not default authority. Re-read every pin.
Keep the same operation/review through receipt or resume interruption; never
manufacture a new operation to bypass a refusal. Run from the clean verified
checkout, with only the authorized central keyring/environment available:

```sh
node --import tsx scripts/local/provider-operator-continuation.mts \
  --review-file /absolute/private/review.json --check-only
node --import tsx scripts/local/provider-operator-continuation.mts \
  --review-file /absolute/private/review.json --apply --review-digest REVIEW_DIGEST
```

The check prints safe counters and a review digest, never cursor/config contents.
Apply takes local residency and a normal fenced import utility lease, stores the
review receipt, then uses authoritative Resume and Run-now commands. Every write
phase rechecks authority, process ownership, full checkpoint, page chain, retained
history, generation, lease and database clock. Pause/stop, null or head checkpoints,
foreign/live leases, active work and drift refuse. Database queue admission binds
the exact import lease, config, generation and actual cursor fingerprint atomically.
The parent remains immutable; audit receipt and deterministic command identities
link it to the independent child. An interrupted already-queued operation returns
that same child without touching its worker ownership. Callback deadlines drain
before releasing residency or credentials. A crashed own lease must expire normally;
never clear ownership with SQL.

After queue acknowledgment, launch the existing backfill supervisor against the
returned **new child run**, unchanged config and the reviewed new operation, using
`--check-only` before `--run`. This utility intentionally does not launch it. Verify
initial committed progress and unchanged parent history. Any new permanent error
stops under the existing policy and requires diagnosis, not automatic requeue.

Acceptance coverage:

| Given / when / then | Evidence |
| --- | --- |
| A valid committed Phygitals checkpoint is reviewed; origin exists only in parent history; 100-record pages and quarantine counters remain intact | `provider-operator-continuation.test.mjs` |
| Cursor contents, head/origin, org/config/route or process ownership changes; continuation refuses | `provider-operator-continuation.test.mjs` |
| A real database operation stops after receipt or Resume; the same receipt resumes exactly once without history loss | `provider-operator-continuation.integration.test.mjs` |
| Another owner obtains a lease or the operator pauses between Resume and Run-now; queue is refused | `provider-operator-continuation.integration.test.mjs` |
| An already-queued operation is repeated while an independent worker owns the lease; no duplicate run or lease release occurs | `provider-operator-continuation.integration.test.mjs` |

Run pure checks with `node --test scripts/local/provider-operator-continuation.test.mjs`.
Real PostgreSQL tests require `PACKSCOUT_OPERATOR_CONTINUATION_INTEGRATION=1` and
`PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY` pointing to local PostgreSQL binaries, then
`node --test scripts/local/provider-operator-continuation.integration.test.mjs`.
They reuse the existing isolated Unix-socket fixture and never connect to a live
database or source. Root owns the complete `npm run verify:framework` gate before
deployment. No schema migration or request-settings rollout is part of this utility.
