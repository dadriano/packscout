# One-time Collector reconciliation repair retry

This local utility admits only the operator-approved recovery of run
`4ac94632-3551-5b5a-a7d5-f2ab359bc681`, failed at `2026-08-30T12:23:20.073Z`
with `PROVIDER_IMPORT_EXECUTION_FAILED`, at unchanged configuration3
`0d53bce0-fe5d-54bf-bd07-f47142690a8f`. The original exception was not retained;
the repaired scaling defect is reproduced, not claimed as its proven cause.
The generic failure remains nontransient. There is no source call in this utility.

Prerequisites: the coherent reconciliation/diagnostic fix and EV-preserving
workspace must pass focused tests and `npm run verify:framework`. Independently
confirm that no old Collector supervisor or worker remains. Keep report automation
paused and leave the other providers and app services alone. Only central
`127.0.0.1:55431/packscout` and its isolated Collector database55434 are permitted.
Use the central credential keyring in the process environment; never pass secrets
as arguments or print environment/configuration/cursor contents.

```bash
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx \
  scripts/local/retry-collector-reconciliation-checkpoint.mts --check-only
```

After reviewing the safe receipt, use `--execute --review-digest HASH`. This stores
one durable operator-reviewed receipt, takes the normal import utility lease, and
uses normal resume (error generation24→idle25) then Run now commands. It preserves
the exact full committed checkpoint, all387 parent pages/387000 accepted/0duplicate/
0quarantine, all retained runs and the promotion ledger. No config, cursor, old run
or canonical row is edited. Full page-chain/history digests are rechecked under
lease→failed-run→runtime lock order. Expired foreign leases are never adopted.

A crash before queue can reuse only this receipt and its own expired utility
lease. A crash after queue returns the same deterministic child, not a duplicate.
Operator pause/stop, generation, central authority, credentials, checkpoint or
history drift refuse. The new worker must use this exact queued child under a new
backfill operation; never repurpose the old failed supervisor's operation. The
utility does not start processes. Confirm initial durable commits and unchanged
parent history independently after activation. Remove this one-time utility once
its recovery evidence has been retained; it is not an ongoing error allowlist.

Focused synthetic tests (no live database or source writes):

```bash
node --test scripts/local/collector-reconciliation-retry.test.mjs
```
