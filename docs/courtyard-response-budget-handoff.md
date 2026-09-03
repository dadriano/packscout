# Courtyard response-budget checkpoint handoff

This local-only utility upgrades one reviewed terminal checkpoint. It does not reset the source, replay prior quarantines, mutate old runs/pages, start a worker, or claim source head. Completed ClutchPacks/publication and the other provider routes are outside its scope.

## Evidence and immutable capacity

Courtyard run `b3195b00-b91f-5c9a-a6ce-9ad57492c818` failed with `PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE` on 2026-08-30 at 15:07:54.584Z, after 2,302 committed pages, 230,045 accepted records and 155 run quarantines. The reviewed checkpoint retains 17,310 historical pages and 684 historical quarantines.

The exact saved-page diagnostic at 19:35:01.529Z returned HTTP200, 100 records and 10,691,962 bytes. Its JSON graph contained 598,207 values, maximum depth9, maximum native-array length6,242 and maximum object-key count33. The 8MiB transport limit and 480,000-value parser limit both prevent that page from completing. Direct per-record diagnostic checks found 100 valid normalized/mapped/canonical collectibles, but the production parser still refused the old graph budget. This diagnostic was not a durable page commit or activation canary.

The new immutable tuple is `dataforrest-courtyard-distributed-adapter-v2`: 100 records/request, 32MiB response budget, 640,000 aggregate JSON values. Native arrays share that aggregate budget. Depth64, object-key256, wire-record5,000, page100, UTF-8/reserved-key protections and canonical validators remain unchanged. Historical Courtyard-v1 and every other existing profile retain 8MiB and 480,000 values. Namespace, native interpretation, mapper, record identity and cursor codec are unchanged. These bounds admit the observed page; they do not guarantee that every future upstream page fits.

The new handoff requires a fresh production-parser/normalizer/mapper/projection/collectible-validator canary with **100 canonical-valid records and zero quarantines**. The earlier native-profile handoff's missing-name exception is not inherited.

## Reproducible synthetic capacity checks

These commands use synthetic bytes, fake capture/persistence and the production capture-terminalization, interpretation, trusted-evidence sealing, completion and import-planning path. They make no source or database requests.

```bash
npm run measure:provider-source-page-memory:local -- --profile courtyard-v2-wide
npm run measure:provider-source-page-memory:local -- --profile courtyard-v2-distributed
```

Each fixed profile measures12 pages after4 warmup pages, one in flight at a time, with exactly32MiB and640,000 JSON values. The wide case concentrates distinct empty objects in one record; the distributed case divides them across100 records. Each must retain the existing per-page limits: peak RSS delta≤64MiB and retained managed growth≤8MiB.

Observed on Node22.22.3/macOS arm64:

| Profile | Measured at2026-08-30 UTC | Peak delta bytes | Retained growth bytes | Result |
| --- | --- | ---: | ---: | --- |
| Courtyard-v2 wide | 19:41:26.064 | 48,119,808 | 454,539 | pass |
| Courtyard-v2 distributed | 19:42:00.598 | 8,454,144 | 416,536 | pass |

The benchmark with no profile argument remains the existing four-concurrent-page, historical8MiB witness. Arbitrary byte/node/concurrency/credential options are rejected.

## Exact handoff and authority

The utility is `scripts/local/handoff-courtyard-response-budget.mts`. Its only operation is `26c70381-925a-5228-87be-4e6b862fa508`; its deterministic new central config is `cb42130b-c474-56cf-81e2-63e603aadeb8` (v3).

It requires central `127.0.0.1:55431/packscout`, organization `3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a`, provider `eeba923b-3d0f-53bc-9006-d84fab651824` / `courtyard`, and a centrally resolved primary route to `127.0.0.1:55433/packscout_courtyard`. No provider DSN, bearer, PID, cursor or limit overrides are accepted. Credential decryption remains process-local; output and persisted receipts contain only allowlisted metadata/hashes.

The old central/runtime config is v2 `a1544542-735e-5df2-932e-0dde904da1f6`, terminal runtime generation21 and released import fence82. The full saved cursor must match the failed run and its last committed page. Full bounded run/page/quarantine metadata digests and the canonical ledger sequence are bound into the operation's review receipt and rechecked during preparation and activation.

## Reviewed operator phases

Run from the isolated checkout with its existing local central/cipher bootstrap. Do not copy secrets into arguments. Every mutation needs the exact review digest returned by the preceding check. `REVIEW_DIGEST` below is a placeholder for that nonsecret digest, not a reusable value.

```bash
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --check-only --operation-id 26c70381-925a-5228-87be-4e6b862fa508
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --pause --operation-id 26c70381-925a-5228-87be-4e6b862fa508 --review-digest REVIEW_DIGEST
```

Pause records its own exact terminal intent, then submits the normal guarded pause command (generation21→22). An unrelated operator pause is never adopted or overridden.

```bash
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --check-only --operation-id 26c70381-925a-5228-87be-4e6b862fa508
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --prepare --operation-id 26c70381-925a-5228-87be-4e6b862fa508 --review-digest REVIEW_DIGEST
```

Prepare makes one hardened saved-cursor canary request unless this operation already has an exact staged proof. It then acquires its own bounded utility import lease and locks import lease→failed run→runtime. While those locks protect the paused checkpoint, it stages an **inactive** immutable central config copying the previous credential/endpoint/settings/schedule and changing only adapter/version metadata. It changes only the cached revision/profile and cursor envelope revision/adapter, retaining the exact opaque value. No old run/page/quarantine is updated.

The provider preparation commits first. A second exact provider-locked transaction then activates central config **last**, with authority and provider-row-version CAS. The utility releases only its own lease.

```bash
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --check-only --operation-id 26c70381-925a-5228-87be-4e6b862fa508
node --import tsx scripts/local/handoff-courtyard-response-budget.mts --resume --operation-id 26c70381-925a-5228-87be-4e6b862fa508 --review-digest REVIEW_DIGEST
```

Resume acquires a distinct operation-owned120-second queue lease, rechecks the prepared checkpoint, uses the normal generation22→23 command, then atomically queues the operation's one deterministic manual run with exact config/cursor fingerprint, `expectedImportLease` and `requireNoActiveRun`. The queue transaction locks and verifies that exact lease against its SQL clock; expiry or a foreign owner between preflight and queue cannot create a child. It does not start a runner. Re-entry after output loss verifies the already-created command and the child's full requested cursor, requester, trigger, config and lineage, then cleans only an operation-owned fenced queue lease before returning its identifiers.

## Refusal and interrupted-phase recovery

- On any unexpected identity, authority, generation, cursor, history, source proof or lease drift, stop and diagnose the sanitized refusal. Do not clear a lease/cursor, rewrite a receipt, change bounds, or choose a different operation to bypass it.
- After an interruption, rerun `--check-only` using the same operation. A live utility lease is not stolen; only this operation's expired lease, exact intent receipt and pause provenance can be reclaimed.
- Inactive staging and committed local preparation are idempotent. A stale proof may be reused only after exact staging; a fresh initial stage requires a≤120-second proof. Local preparation remains paused if central activation fails.
- If activation committed but release/output was lost, finish the same prepare phase and owned-lease cleanup before resuming. If resume committed but queue/output was lost, the same resume phase queues or recognizes only its deterministic child; it does not submit a second resume/run.
- The operation never converts `INVALID_RESPONSE` into an automatic transient retry, drops validation, skips source records, or replays the684 historical quarantines.

Live activation and the fresh production canary are separate operator evidence; synthetic tests alone do not authorize or claim that they have occurred.
