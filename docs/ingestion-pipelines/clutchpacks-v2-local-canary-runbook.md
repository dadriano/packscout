# ClutchPacks V2 local canary qualification and replay

Status: archived historical evidence; not a current operator runbook

This completed v2 canary record is retained for audit context only. Production
registers adapter v3 exclusively for every DataForrest provider, the v2 package
commands have been retired, and operators must not invoke the underlying v2
scripts directly. Use the
[ClutchPacks V3 local canary](./clutchpacks-v3-local-canary-runbook.md) for the
current clean-slate replay.

The historical workflow qualified and started only the ClutchPacks adapter-v2 source in
the fresh, separate local PostgreSQL database created by
`bootstrap:clutchpacks-v2-canary:local`. It does not use Neon, clone the active
database, or stop the Collector Crypt, Courtyard, or Phygitals lanes.

## Invariants

- `PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL` identifies the active local V1
  database, while `PACKSCOUT_DATABASE_URL` identifies the separate canary.
- Both guarded database URLs must be canonical database-root URLs without a
  query string (for example, omit a normal `?schema=public` client suffix).
  This keeps the digest and connected-database identity bound to one exact
  local database rather than to client-specific URL options.
- Both URLs must resolve to different, explicitly named local databases.
- Before every driver action, the active V1 source database must prove the
  exact platform-request-lanes migration checksum and its intentional
  84-application-table subset. The target independently proves the current
  88-table composite schema through its full lifecycle startup.
- The target contains exactly one organization, one active ClutchPacks provider
  root, one DataForrest connection profile, and one ClutchPacks source.
- The provider root is identity-only: it has no legacy active revision, next
  run, config revision, secret version, or cursor checkpoint.
- The target connection and source revisions use
  `dataforrest-events-adapter-v2` only. The source revision must also exactly
  pin normalized contract `packscout.provider-observation.v1`, mapper
  `clutchpacks-provider-observation@1`, identity namespace
  `dataforrest-clutchpacks-records-v1`, and cursor codec
  `dataforrest-cursor-v1`.
- The connection profile keeps the governed per-platform `requestLimit: 2`.
- The target supervisor runs with exactly one execution slot. Therefore this
  canary makes at most one provider request at a time even though the governed
  request limit is two.
- Before a test can be queued, a qualification transition can run, or replay
  can start, the exact original adapter-v1 ClutchPacks source must be paused and
  have zero queued or running import runs.
- Before resume, the target cursor must still be generation 1 at Feed start,
  with no cursor fingerprint and no import lineage.
- Final target pause is allowed only after the actual latest, fully pinned V2
  run succeeded at provider head and the target has no queued or running runs.
  The whole target must also contain zero quarantine records and zero
  warning/error/critical source diagnostics. The target supervisor must be
  stopped before that pause.

The driver never starts a worker and never calls DataForrest directly. It uses
the source lifecycle services to pause, queue tests, activate tested revisions,
activate the source paused, and resume it. All mutating actions require a
confirmation bound to the source/target/org digest printed by `--status`.

## Protected environment

Load the same ignored local environment used for bootstrap. It must contain:

```text
NODE_ENV=development
PACKSCOUT_RUNTIME_ENVIRONMENT=local
PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL=...
PACKSCOUT_DATABASE_URL=...
PACKSCOUT_CLUTCHPACKS_V1_ORGANIZATION_ID=...
PACKSCOUT_CLUTCHPACKS_V2_CANARY_ORGANIZATION_ID=...
PACKSCOUT_CLUTCHPACKS_V2_TARGET_ACK=I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE
PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64=...
PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION=...
```

The separately started target supervisor also needs its normal protected
settings, including `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64` and
`PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH`. Never paste secret values into command
history, logs, tickets, or this runbook.

## Run the workflow

1. Inspect the read-only status. Save the four exact confirmation strings from
   its JSON output.

   ```bash
   npm run advance:clutchpacks-v2-canary:local -- --status
   ```

   `--plan` is an equivalent read-only view intended for a pre-change review.

2. Pause only the original ClutchPacks V1 source with the printed
   `pauseOriginal` confirmation.

   ```bash
   npm run advance:clutchpacks-v2-canary:local -- \
     --pause-original --confirmation "PAUSE ORIGINAL CLUTCHPACKS V1 LOCAL <digest>"
   ```

   An `outcome` of `draining` is expected when a page was already running.
   Re-run `--status`; do not proceed until `original.ready` is `true`. The
   command is restart-safe and returns `already_paused` when no change is
   needed.

3. In a separate terminal, start exactly one source-only supervisor against the
   canary database. The environment must still bind `PACKSCOUT_DATABASE_URL` to
   the canary target.

   ```bash
   PACKSCOUT_SOURCE_EXECUTION_SLOTS=1 npm run start:source-supervisor:local
   ```

   Do not run the combined worker or a second supervisor against this target.
   Wait until `--status` reports `supervisor.ready: true`; the driver validates
   the live durable supervisor snapshot, not just the caller's environment.

4. Advance one transition at a time with the printed `advance` confirmation.

   ```bash
   npm run advance:clutchpacks-v2-canary:local -- \
     --advance --expected-stage <targetStage> \
     --confirmation "ADVANCE CLUTCHPACKS V2 LOCAL <digest>"
   ```

   Copy the exact current `targetStage` into `--expected-stage`. That stage
   fence makes a retry refuse after the prior transition committed, so a lost
   terminal response cannot silently advance twice. Re-run only after
   inspecting the new `targetStage`. The ordered stages are:

   ```text
   queue_connection_test
   wait_connection_test
   activate_connection
   queue_source_test
   wait_source_test
   activate_source_paused
   ready_to_resume
   ```

   A waiting stage performs no mutation. A failed or fenced test stops the
   workflow with a stable safe code; do not retry or bypass it without
   diagnosing the supervisor result.

5. At `ready_to_resume`, inspect `--status` once more. Confirm the original is
   still paused and drained, the supervisor still has one available slot, the
   target cursor remains at Feed start, and `lineageRows` is zero. Then use the
   separately printed `resume` confirmation.

   ```bash
   npm run advance:clutchpacks-v2-canary:local -- \
     --resume --confirmation "RESUME CLUTCHPACKS V2 LOCAL <digest>"
   ```

   Resume is the only action that makes the canary source eligible for page
   reads. The already-running one-slot supervisor performs the replay. The
   driver itself performs no provider request.

6. Let replay continue until `--status` reports all of the following exact
   evidence:

   ```text
   target.latestRunState: succeeded
   target.latestRunReachedProviderHead: true
   target.latestRunExactSucceededHead: true
   target.queuedOrRunningRuns: 0
   target.quarantineRecords: 0
   target.warningErrorCriticalDiagnostics: 0
   target.targetWideEvidenceClean: true
   ```

   Then stop the target supervisor with `Ctrl-C` and wait for it to exit. Run
   `--status` again and require `supervisor.liveEpochCount: 0`. The normal
   supervisor release is part of the proof; do not delete or rewrite its epoch.

   Pause only the V2 canary with the printed `pauseTarget` confirmation:

   ```bash
   npm run advance:clutchpacks-v2-canary:local -- \
     --pause-target \
     --confirmation "PAUSE CLUTCHPACKS V2 TARGET LOCAL <digest>"
   ```

   This command uses `ProviderSourceLifecycleService.pause`, then re-reads the
   target and proves the exact head run is still latest, no target run is queued
   or running, target-wide quarantine and warning/error/critical diagnostic
   counts remain zero, the supervisor remains stopped, and the canary source is
   paused without a pending pause request. A safe retry returns
   `already_paused` and the status stage becomes `replay_paused`.

7. Generate and approve the complete public identity candidate by following
   [ClutchPacks V2 public catalog candidate](./clutchpacks-v2-public-catalog-candidate-runbook.md).
   That workflow independently re-reads the frozen replay and does not use the
   active V1 database or Neon.

## Stop conditions

Stop and inspect before making another mutation when the driver reports any of
these categories:

- original V1 database is not the exact 84-table/checksum subset, or its source
  is not exact, paused, or drained;
- target topology, lifecycle pins, cursor, or pristine lineage is not exact;
- during qualification or replay start, the target supervisor is absent,
  stale, capacity-blocked, or not one slot;
- during final target pause, any target supervisor is still live or the latest
  target run is not an exact succeeded provider-head run, any quarantine record
  exists, or any warning/error/critical source diagnostic exists;
- a connection or source test failed, was cancelled, or was fenced;
- a qualification or resume service transition was fenced.

The error JSON contains only a stable safe code. It never includes database
URLs, bearer credentials, encryption keys, provider response bodies, or raw
service errors.
