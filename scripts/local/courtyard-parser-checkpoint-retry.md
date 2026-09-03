# One-time Courtyard parser-repair checkpoint retry

This local exception retries only failed run `183ba6ef-125e-5dc0-b5d6-05aff4074f7f`
at unchanged config2 `a1544542-735e-5df2-932e-0dde904da1f6` and checkpoint hash
`d0946bb1bec84952f25f79785df0eeef27227a3aa304b6d75d15080c6ef044d1`.
The failure remains `PROVIDER_DATAFORREST_INVALID_RESPONSE`, non-transient, at
`2026-08-30T06:27:50.656Z`. All75 historical attempts,18 committed pages,
1,496 accepted records,304 run quarantines/475 total quarantines and canonical
ledger history are retained. No configuration, cursor or historical run is edited.

Root must first verify the repaired production parser on the same saved source
page:100 outcomes, continuation more, ≤8MiB. The reviewed repair uses the existing
480,000-node aggregate budget for native arrays; other parser bounds remain.
Root retains that actual canary evidence separately. This utility makes no source
request and explicitly records `sourceCheckPerformedByUtility:false`; its receipt
is an operator-authorized parser-repair retry, not an assertion that all source
records are canonically valid. Record-local quarantine behavior remains unchanged.

Keep new Courtyard workers/supervisors stopped until queue acknowledgment. Other
providers are not in scope. Use the existing local central55431 bootstrap/keyring;
provider DSNs and source bearer overrides are not accepted. Current active admin,
config/source credential/topology and exact local Courtyard55433 gateway authority
must match. The operation UUID is fixed: `0d6782e0-40b5-4755-8f2c-0611ce48c15c`.

```bash
env -u PACKSCOUT_DATA_API_TOKEN NODE_ENV=development node --import tsx \
  scripts/local/retry-courtyard-parser-checkpoint.mts --check-only
```

After root's source proof and review, repeat with `--execute --review-digest HASH`.
The intent is persisted under lease→failedrun→runtime locks before lease acquisition.
It pins exact error/generation6, released fence76, all18 page hash links/counters,
whole-run history, quarantine and ledger digest. The normal fenced import lease is
acquired; locked SQL-clock and full-checkpoint guards are repeated before resume
and queue. Existing authoritative resume moves error6→idle7. Atomic Run now pins
the same config/cursor and refuses other active work; IDs are deterministic.

Interrupted intent/lease acquisition or resume-before-queue reuses this receipt.
Only this exact operation's expired own lease may be reclaimed; live/foreign
leases refuse. Operator pause/generation drift refuses. A previously queued,
running or terminal exact operation-owned run returns already_queued without
creating a new attempt or interfering with its lease. If a process died after
queue but before releasing its utility lease, allow its normal120s lease expiry
before starting a worker; do not clear it with SQL.

The utility starts no process. Root launches only the new exact queued run and
checks initial commits. Future INVALID_RESPONSE still blocks the generic supervisor.
Remove this one-time utility after the reviewed recovery evidence is retained.

Focused checks use synthetic/fake boundaries, never live source or DB mutations:

```bash
node --test scripts/local/courtyard-parser-checkpoint-retry.test.mjs
```
