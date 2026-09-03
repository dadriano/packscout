# Remote provider import observations

The separate `scripts/local/inspect-remote-provider-import-health.mts` utility observes reviewed remote databases. It never enables a resident, calls a provider source, changes runtime state, retries a run, or grants recovery authority. The historical local inspector remains local-only.

The operator supplies an absolute `--scope-file` path to an owned private regular JSON file (mode 0600; at most 16 KiB; no symlink). Example shape, with placeholders to replace from reviewed evidence:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "<exact clean 40-character commit>",
  "migrationEvidence": {
    "path": "/absolute/private/reviewed-migration-proof.json",
    "sha256": "<SHA256 of the exact reviewed file bytes>"
  },
  "centralHost": "<exact reviewed central host>",
  "organizationId": "<organization UUID>",
  "operatorId": "<active admin operator UUID>",
  "providers": [{
    "providerKey": "clutchpacks",
    "providerId": "<provider UUID>",
    "configId": "<active config UUID>",
    "configNumber": "<positive decimal version>",
    "routeHost": "<exact reviewed provider host>",
    "routeDigest": "<full route digest>"
  }]
}
```

`remoteProviderRouteDigest(route)` is exactly `backfillDigest(full ProviderDatabaseRoute)`: canonical SHA256 after the established bigint-to-decimal JSON conversion. Its input includes organization, target identity/schema/database, active config, provider and topology revisions, node host/port/TLS/revision, credential revision and encrypted credential bytes. It is **not** `providerDatabaseRouteFingerprint`, which omits destination and credential bytes. Obtain pins from the reviewed route evidence using this exported function; the inspector has no permissive discovery or adopt option. Migration evidence is opaque, owned/private, non-symlink, bounded to 4 MiB and byte-hash checked. It does not implicitly authorize anything described inside it.

Before constructing any database client, the utility checks scope, evidence bytes, exact clean checkout, explicit remote mode, central hostname/TLS policy and every pinned provider host against the runtime allowlist. Provider routes require port 5432 and `verify-full`. The configured environment is loaded by the existing backfill loader only after file/code review checks. No environment or DSN is output.

Each provider observation uses a fresh read-only repeatable-read transaction: 5-second acquisition wait, 25-second transaction limit and 10-second statement limit. The public bounded gateway has a 5-second connection and 35-second operation limit. Each surrounding central authority read uses a 20-second read-only transaction and validates current database, role, schema and central identity through the public readiness helper. Active admin membership, immutable configuration, integration registry and exact route are rechecked before and after the provider read. A changed authority discards the observation. Rejected transaction and timed-out gateway callbacks are drained before another read or resource close; a timeout is never treated as cancellation.

Output includes safe runtime/run revisions, generation, full-envelope checkpoint hash validity, all import/promotion lease presence and fences, active/actionable counts, run-ledger aggregate counters, quarantine counts and the latest safe head-reconciliation receipt metadata. Missing rows/read failures are unavailable; absent history has null sums, not fabricated zero progress. Raw cursors, configurations, account records, failure summaries, owner strings and credential material are excluded. No canonical-table full counts are performed. A database snapshot does not observe resident processes: `head_reached_resident_unobserved` is not evidence of a resident waiting, and a pause with owned leases or active work is reported separately. This is observational health, never an automatic restart decision.

Run only after review, full framework verification, commit and creation of private pins for that exact clean commit:

```sh
node --import tsx scripts/local/inspect-remote-provider-import-health.mts --scope-file /absolute/private/scope.json
```

Acceptance map:

| Given / when / then | Coverage |
| --- | --- |
| Wrong scope, commit, evidence bytes, file permissions, remote mode, hostname or TLS: refuse before authority/connection | Automated: `remote-provider-health-policy.test.mjs` |
| Missing active admin, wrong tenant/provider/config, unsupported integration or changed full route: unavailable | Automated: same policy tests and `remote-provider-health-read.test.mjs` |
| Wrong provider database/runtime identity, missing leases/counts or no history: unavailable, never invented counters | Automated: read tests |
| Successful observation: preserve useful counts/hashes; emit no protected payload or owner; perform only allowed read SQL and no fetch | Automated: read tests with rejecting synthetic delegates and source stub |
| Reconciliation receipt advances under an exact live fence: reconciling; old/invalid receipt: stalled/invalid | Automated: read tests |
| Transaction/gateway times out while callback is pending: drain it before return/close | Automated: read tests |
| Actual remote readback and reviewed deployment environment | Manual gap: requires operator-reviewed private scope after the canonical gate; implementation tests use synthetic in-memory clients and never access `.env`, live databases or sources |
