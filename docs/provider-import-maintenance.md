# Continuous local provider import maintenance

Owner: the PackScout ingestion operator and the Codex maintenance task
`01a055d7-5065-7581-9025-768748c19706`. The user authorized ongoing diagnosis,
mitigation, verified fixes, deployment, and safe recovery on 2026-08-30.

## Scope and safety

The local central database is `127.0.0.1:55431/packscout`. Provider routes are
resolved from central authority for organization
`3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a`: ClutchPacks 55432, Courtyard 55433,
Collector Crypt 55434, and Phygitals 55435. Validate provider/database identity,
current configuration and operator membership before any recovery.

Do not use the legacy port 5432 import runtime. Preserve Admin 5111, frontend
5100, local Convex 3210, all canonical/history/quarantine rows, and ClutchPacks
EV/chase data. The unrelated managed-request-size rollout requires separate
schema, credentials, initialization and worker admission checks; it is not part
of this maintenance rollout. No implicit migrations or request-limit changes.

Local operation requires this Mac to be available and awake. Process supervision
and ten-minute Codex checks reduce interruption; they do not guarantee upstream,
hardware, network, or Codex availability. Source head means the historical
backfill is caught up. It must transition to indefinite scheduled polling.

## Current operational record

Read the private directory
`~/Library/Application Support/PackScout/provider-import-maintenance` before
acting. `operation.json` identifies the active maintenance owner and rollout
state. Preserve a sanitized deployment manifest and before/after health snapshots
there. Keep files private, and never store raw source cursors or secrets in
reports. A historical PID, log, or commit is not current ownership proof.
Monitor available disk bytes and database growth. Low space is an operational
incident; do not delete history, quarantine, captures, or another task's files to
make space. Use graceful provider stops before disk exhaustion and request a
concrete capacity decision if safe storage cannot be restored.

The initial rollout is being prepared in
`.worktrees/provider-import-reliability`, based on the coherent `49c1ed27` worker
tree. A prepared branch is not evidence of deployment. Only the private manifest
and freshly observed job, lease, run and checkpoint state establish deployment.

## Inspect before acting

From the deployed, reviewed worktree, with its existing private local environment:

```bash
NODE_ENV=development node --import tsx scripts/local/inspect-provider-import-health.mts \
  --organization-id 3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a
```

This performs bounded read-only database and local resident-health reads. It
reports all four providers, exact canonical table counts, accepted/page totals,
quarantines, run state, checkpoints as hashes, lease state, configured next due
time and resident presence. A missing/unreachable provider is unavailable, not
zero. Counts of accepted records are operations, not unique entities or a known
percent complete. A live socket alone is not proof of import progress.

Compare consecutive snapshots and confirm current launchd/process identity.
Distinguish active backfill, source-head reconciliation/finalization, caught-up
waiting, overdue scheduling, stalled work, failed work, and explicit operator
pause/stop. During reconciliation, compare the current run's validated receipt
batch and timestamp as well as its lease and heartbeat; source-page counts may
correctly remain unchanged while references are resolved. The inspector's three-minute
progress threshold is an alert to investigate, never authorization to kill a
worker or steal its lease. Waiting until the configured next due time is normal.

## Recovery and rollout

1. Establish one maintenance owner; coordinate any other active task before
   stopping, starting, recovering or deploying the same provider.
2. Capture sanitized failure stage/category, stable run/checkpoint/config IDs,
   leases, process identities, counters and committed-page evidence. Do not dump
   errors, SQL, account rows, credentials, provider payloads or raw cursors.
3. Let the resident supervisor handle only its explicitly supported transient
   failures and same-operation crash recovery. Unknown/permanent failures remain
   blocked for diagnosis. Do not broaden generic retries to every Prisma P2028
   error or `PROVIDER_IMPORT_EXECUTION_FAILED`. A terminal failure after source
   head requires diagnosis too; a normal source retry must not discard its saved
   reconciliation work.
4. Implement the narrow fix in an isolated checkout, add meaningful regression
   coverage, and run focused checks followed by `npm run verify:framework`.
   Never baseline or suppress a new finding to make the gate pass.
5. Use the reviewed audited operator-continuation utility when permanent failure
   needs an explicit new attempt. Bind the exact saved checkpoint, current
   generation/configuration, failed parent, utility lease and review digest. Keep
   the failed run immutable and record the new independent continuation in audit.
6. Deploy from a clean verified commit. Gracefully hand off exactly one provider
   at a time, retain stable resident operation pins, and verify process/lease
   exclusivity and durable progress. Confirm eventual source-head handoff and
   subsequent scheduled polls. Do not change unrelated providers or services.

The ten-minute `PackScout import maintenance` automation stays active indefinitely
until the user stops or changes it. It may diagnose, repair and deploy verified
fixes under the user's standing authorization. It must respect later deliberate
pause/stop, upstream limits and security boundaries. Destructive actions, missing
migration authority, or irreducible external blockers require a concrete user
decision; preserve the affected provider and continue maintaining the others.

## Acceptance coverage

| Behavior | Evidence |
| --- | --- |
| A completed head still requires a resident and future polling | Automated: `provider-import-health-policy.test.mjs` |
| Pause/stop and failed/stalled work are never reported as healthy | Automated: same policy tests |
| Safe operator continuation and crash-safe resident handoff | See the companion continuation and resident supervision acceptance maps |
| Actual four-provider progress after deployment | Operational check: private timestamped before/after snapshots and deployment manifest; do not infer from tests |
